// usage.mjs — shared OpenCode Go dashboard scraper + daily-budget logic.
// Used by the background service worker (popup.mjs imports it too).
// No network owns a singleAUTHORIZED destination: opencode.ai only.

// ---------- Plan limits (dollar values) ----------
// From https://opencode.ai/docs/go/
export const LIMITS = {
  rolling:  { usd: 12, windowSec: 5 * 3600 },     // 5h, $12
  weekly:   { usd: 30, windowSec: 7 * 86400 },    // 7d, $30
  monthly:  { usd: 60, windowSec: 30 * 86400 },   // 30d, $60
};

export const FETCH_TIMEOUT_MS = 12000;

export const ROLLING_THRESHOLD_WINDOWS = ['rolling', 'weekly'];
export const USAGE_NOTIFICATION_THRESHOLDS = [50, 75, 100];
export const ADAPTIVE_POLL_MINUTES = {
  idle: 60,
  active: 5,
  unchanged: 30,
  fallback: 30,
};

/** Extract the workspace id from a /workspace/<id>/... URL. Returns null if not found. */
export function workspaceIdFromUrl(url) {
  const m = String(url).match(/\/workspace\/([^/?#]+)/);
  return m ? m[1] : null;
}

/** Build the dashboard URL for a given workspace id. */
export function dashboardUrlFor(workspaceId) {
  return `https://opencode.ai/workspace/${workspaceId}/go`;
}

/**
 * Fetch the /go dashboard HTML for the supplied workspaceId using the user's
 * existing Chrome session cookies. Requires host_permissions for opencode.ai
 * and `credentials: 'include'` (the extension origin is chrome-extension://,
 * which is cross-origin to opencode.ai, so 'same-origin' would NOT send cookies).
 *
 * Returns { ok, status, html, finalUrl } or { ok:false, status, error, authRequired }.
 * authRequired=true when the request ends up on a login page.
 */
export async function fetchDashboard(workspaceId) {
  const url = dashboardUrlFor(workspaceId);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { Accept: 'text/html,application/xhtml+xml,*/*' },
    });
    clearTimeout(timer);
    const finalUrl = resp.url || '';
    const html = await resp.text();
    // Detect an OpenAuth login redirect: the page shows the GitHub/Google buttons
    // and does NOT contain the lite.subscription.get marker.
    const looksLikeDashboard = html.includes('lite.subscription.get');
    const looksLikeLogin =
      /\/(github|google)\/authorize\b/.test(finalUrl) ||
      (html.includes('Continue with GitHub') && !looksLikeDashboard);
    if (!looksLikeDashboard || looksLikeLogin) {
      return { ok: false, authRequired: true, finalUrl, status: resp.status };
    }
    return { ok: true, status: resp.status, html, finalUrl };
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') {
      return { ok: false, error: 'timeout' };
    }
    return { ok: false, error: String(e && e.message || e) };
  }
}

/**
 * Parse the SolidJS streaming-hydration inline <script> in the dashboard HTML
 * for the three usage windows. Regex is anchored on the resource key
 * `lite.subscription.get["<workspaceId>"]` then extracts the three
 * `(rolling|weekly|monthly)Usage:$R[N]={status:"ok",resetInSec:N,usagePercent:N}`.
 *
 * NOTE: the regex is anchored on the per-window `xxxUsage:$R[N]={...}` shape,
 * not on the `lite.subscription.get` resource key, so it tolerates SolidJS
 * reordering the resource-key declarations as long as the per-window object
 * shape is unchanged. If the per-window shape itself changes (key names,
 * nesting, the `$R` ref format), parse fails with `{ok:false}` and the UI
 * surfaces a parse-error state — there is no silent wrong-data path.
 */
export function parseUsageFromHtml(html) {
  if (!html) return { ok: false, error: 'empty html' };
  const out = { rolling: null, weekly: null, monthly: null, useBalance: null };
  let found = 0;

  const winRe = /(rolling|weekly|monthly)Usage:\$R\[\d+\]=\{status:"ok",resetInSec:(\d+),usagePercent:(\d+)\}/g;
  let m;
  while ((m = winRe.exec(html)) !== null) {
    const name = m[1];
    const resetInSec = parseInt(m[2], 10);
    const usagePercent = parseInt(m[3], 10);
    out[name] = { resetInSec, usagePercent };
    found++;
  }

  // useBalance (fallback-to-Zen-balance toggle) lives in the same subscription object.
  const useBalanceRe = /useBalance:(!0|!1|true|false)\b/;
  const ub = useBalanceRe.exec(html);
  if (ub) out.useBalance = (ub[1] === '!0' || ub[1] === 'true');

  if (found === 0) {
    return { ok: false, error: 'no usage windows found' };
  }
  return { ok: true, windows: out };
}

// ---------- Daily-budget (prorated) logic ----------

/**
 * Compute how much of a given usage window has "elapsed" so far, based on the
 * remaining reset time. Returns a number in [0,1).
 * elapsed = 1 - resetInSec / windowSec
 */
export function elapsedFraction(resetInSec, windowSec) {
  if (!Number.isFinite(resetInSec) || resetInSec < 0) return 0;
  if (resetInSec >= windowSec) return 0;
  return 1 - resetInSec / windowSec;
}

/**
 * "How much usage you would be at if you were perfectly on pace."
 * expectedPercent = elapsedDays * 100 / 30  but computed on the same fraction.
 */
export function expectedPercentForWindow(wName, resetInSec) {
  const win = LIMITS[wName];
  if (!win) return 0;
  return elapsedFraction(resetInSec, win.windowSec) * 100;
}

/**
 * Pace = currentUsagePercent - expectedPercentSoFar.
 * Positive = using faster than the clock (risk of hitting the cap).
 * Negative = headroom.
 */
export function pacePct(windowName, usagePercent, resetInSec) {
  const expected = expectedPercentForWindow(windowName, resetInSec);
  return usagePercent - expected;
}

/**
 * "今日あと何%使えるか" for ANY workspace — the core value of this extension.
 *
 * Definition (shown verbatim in the UI): the remaining-budget-on-the-prorated-pace.
 *   remainder = expectedSoFar - current
 * but bounded to be meaningful near reset boundaries:
 *   - When the window just reset (resetInSec ≈ windowSec, elapsed≈0), expected≈0,
 *     so "remaining today" ≈ 100 - current (almost everything is available).
 *   - When the window is about to reset (resetInSec ≈ 0, elapsed≈100%), we are
 *     at the end of the period; cap the displayed "remaining at this pace" at 0
 *     and surface "resets soon" instead (the popup handles this).
 *
 * Per-day allowance (e.g. monthly 30d) is shown in the popup as the reference unit,
 * NOT recomputed into today: we keep "remaining at current pace" which is a
 * window-fraction, so this is dimensionless and works for rolling/weekly too.
 *
 * @returns { remainingPct, expectedPct, pacePct, resetInSec, usagePercent, dailyAllowancePct }
 *   remainingPct  - how many percentage POINTS you still have before you reach the
 *                   prorated-expected level (can be negative = over-running pace).
 *   dailyAllowancePct - 100 / (window days). For monthly = 3.33.
 */
export function budgetForWindow(windowName, usagePercent, resetInSec) {
  const win = LIMITS[windowName];
  if (!win) {
    return { remainingPct: NaN, expectedPct: NaN, pacePct: NaN, resetInSec, usagePercent, dailyAllowancePct: NaN, elapsedDays: NaN, elapsedDayIndex: NaN };
  }
  const windowDays = win.windowSec / 86400;
  const dailyAllowancePct = 100 / windowDays;
  const elapsedDays = elapsedFraction(resetInSec, win.windowSec) * windowDays;
  const elapsedDayIndex = Math.min(windowDays, Math.max(1, Math.ceil(elapsedDays)));
  const expected = windowName === 'monthly'
    ? elapsedDayIndex * dailyAllowancePct
    : expectedPercentForWindow(windowName, resetInSec);
  const pace = usagePercent - expected;
  // "remaining at the prorated pace": clamp the lower end so we don't show wildly
  // negative numbers right at reset (noisy). Keep the sign so the UI can turn red.
  const remaining = expected - usagePercent;
  return {
    remainingPct: remaining,
    expectedPct: expected,
    pacePct: pace,
    resetInSec,
    usagePercent,
    dailyAllowancePct,
    elapsedDays,
    elapsedDayIndex,
  };
}

export function localDateKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function cloneJson(value) {
  return value ? JSON.parse(JSON.stringify(value)) : {};
}

function notificationWorkspaceBucket(lastNotif, workspaceId) {
  const workspaceKey = workspaceId || 'unknown';
  const root = cloneJson(lastNotif);
  root.byWorkspace ||= {};
  root.byWorkspace[workspaceKey] ||= {};
  root.byWorkspace[workspaceKey].thresholds ||= {};
  return { root, bucket: root.byWorkspace[workspaceKey], workspaceKey };
}

function resetAdvanced(previousWindow, currentWindow, toleranceSec = 60) {
  if (!previousWindow || !currentWindow) return false;
  return currentWindow.resetInSec > previousWindow.resetInSec + toleranceSec;
}

/**
 * Plan the next background poll from only the 5h rolling usage window.
 *
 * Rules:
 * - rolling usage is 0%: the user is probably idle or the 5h window reset -> 1h
 * - rolling usage increased since the previous successful poll: user is active -> 5m
 * - rolling usage did not increase: keep a lighter watch -> 30m
 *
 * The first non-zero reading is treated as active so usage started between polls
 * quickly tightens the interval after it is detected.
 */
export function nextAdaptivePollMinutes(previousWindows, windows) {
  const current = windows?.rolling?.usagePercent;
  if (!Number.isFinite(current)) return ADAPTIVE_POLL_MINUTES.fallback;
  if (current <= 0) return ADAPTIVE_POLL_MINUTES.idle;

  const previous = previousWindows?.rolling?.usagePercent;
  if (!Number.isFinite(previous)) return ADAPTIVE_POLL_MINUTES.active;
  if (current > previous) return ADAPTIVE_POLL_MINUTES.active;
  return ADAPTIVE_POLL_MINUTES.unchanged;
}

/**
 * Pure notification planner used by the background worker.
 *
 * - monthly: notify at most once per local date while usage is above the
 *   prorated allowed percent (usagePercent > expectedPct).
 * - rolling/weekly: notify once for each 50/75/100% threshold until that
 *   window's reset countdown advances, which re-arms the thresholds.
 */
export function planUsageNotifications({ lastNotif, workspaceId, previousWindows, windows, now = Date.now() }) {
  const { root, bucket } = notificationWorkspaceBucket(lastNotif, workspaceId);
  const events = [];
  const dateKey = localDateKey(now);

  if (windows?.monthly) {
    const b = budgetForWindow('monthly', windows.monthly.usagePercent, windows.monthly.resetInSec);
    if (b.pacePct > 0 && bucket.monthlyOverDate !== dateKey) {
      events.push({ type: 'monthly-over', window: 'monthly', dateKey, budget: b });
      bucket.monthlyOverDate = dateKey;
    }
  }

  for (const windowName of ROLLING_THRESHOLD_WINDOWS) {
    const current = windows?.[windowName];
    if (!current) continue;
    const previous = previousWindows?.[windowName];
    const state = bucket.thresholds[windowName] || { sent: {} };
    if (resetAdvanced(previous, current)) state.sent = {};
    state.lastResetInSec = current.resetInSec;

    for (const threshold of USAGE_NOTIFICATION_THRESHOLDS) {
      const key = String(threshold);
      if (current.usagePercent >= threshold && !state.sent[key]) {
        events.push({ type: 'threshold', window: windowName, threshold, usagePercent: current.usagePercent, resetInSec: current.resetInSec });
        state.sent[key] = true;
      }
    }
    bucket.thresholds[windowName] = state;
  }

  return { events, lastNotif: root };
}

/**
 * Bucket a pace + remaining into a severity for color/alerts.
 *   healthy (green)  — pace <= 0 (on/under pace)
 *   warn   (yellow)  — 0 < pace <= 1 dailyAllowance
 *   over   (red)     — pace > 1 dailyAllowance
 */
export function severityForPace(pace, dailyAllowancePct) {
  if (pace <= 0) return 'healthy';
  if (pace <= dailyAllowancePct) return 'warn';
  return 'over';
}

/** Human-readable "resets in" string from resetInSec. */
export function formatResetIn(resetInSec, now = Date.now()) {
  if (!Number.isFinite(resetInSec) || resetInSec < 0) return '—';
  const s = Math.floor(resetInSec);
  if (s < 60) return `${s}秒`;
  const mins = Math.floor(s / 60);
  if (mins < 60) return `${mins}分`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  if (days > 0) return `${days}日 ${remH}時間`;
  return `${hours}時間 ${remMin}分`;
}