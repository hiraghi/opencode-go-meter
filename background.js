// background.js — MV3 service worker.
// Polls the OpenCode Go dashboard on a schedule, updates the toolbar badge
// with the monthly usage %, and surfaces auth-expiry / over-pace notifications.
// Authentication uses the user's existing Chrome login session (cookies) via
// fetch(..., {credentials:'include'}); no token storage or manual cookie entry.
//
// Single network destination: opencode.ai only.

import {
  fetchDashboard,
  parseUsageFromHtml,
  budgetForWindow,
  severityForPace,
  formatResetIn,
  planUsageNotifications,
  nextAdaptivePollMinutes,
  ADAPTIVE_POLL_MINUTES,
} from './src/usage.mjs';

const ALARM_NAME = 'go-poll';
const STORAGE_KEY = 'state';
const NOTIF_AUTH = 'go-auth-expired';
// Chrome notifications require iconUrl. The toolbar/manifest icon files were
// removed because their provenance was unknown, so notifications use this small
// inline, source-controlled glyph instead of any external asset.
const NOTIFICATION_ICON_URL = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="#1f2937"/><text x="24" y="30" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="700" fill="#fff">Go</text></svg>')}`;

async function getState() {
  const v = await chrome.storage.local.get(STORAGE_KEY);
  return v[STORAGE_KEY] || { workspaceId: null, last: null, lastNotif: null };
}

async function setState(patch) {
  const cur = await getState();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

async function scheduleNextPoll(delayInMinutes) {
  await chrome.alarms.create(ALARM_NAME, { delayInMinutes });
}

/** Discover the workspace id from the currently-open opencode.ai tab if any. */
async function discoverWorkspaceId() {
  const tabs = await chrome.tabs.query({ url: 'https://opencode.ai/workspace/*' });
  for (const t of tabs) {
    const m = String(t.url).match(/\/workspace\/([^/?#]+)/);
    if (m) return m[1];
  }
  return null;
}

function badgeColorForPace(pace, daily) {
  const sev = severityForPace(pace, daily);
  if (sev === 'over') return '#e53935';   // red
  if (sev === 'warn') return '#f9a825';   // amber
  return '#2e7d32';                         // green
}

async function updateBadge(monthly) {
  if (!monthly || typeof monthly.usagePercent !== 'number') {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#777' });
    return;
  }
  const text = `${Math.round(monthly.usagePercent)}%`;
  await chrome.action.setBadgeText({ text });
  const b = budgetForWindow('monthly', monthly.usagePercent, monthly.resetInSec);
  await chrome.action.setBadgeBackgroundColor({ color: badgeColorForPace(b.pacePct, b.dailyAllowancePct) });
}

async function emitUsageNotifications(events) {
  for (const event of events) {
    try {
      if (event.type === 'monthly-over') {
        const b = event.budget;
        await chrome.notifications.create(`go-monthly-over-${event.dateKey}-${Date.now()}`, {
          type: 'basic',
          iconUrl: NOTIFICATION_ICON_URL,
          title: 'OpenCode Go 月間利用量が今日の許容量を超過',
          message: `月間 ${b.usagePercent}% 使用。今日時点の許容 ${b.expectedPct.toFixed(1)}% を ${Math.abs(b.pacePct).toFixed(1)}% 超えています。残 ${formatResetIn(b.resetInSec)} でリセット。`,
          priority: 1,
        });
      }
      if (event.type === 'threshold') {
        const label = event.window === 'rolling' ? '5hローリング' : '週間ローリング';
        await chrome.notifications.create(`go-${event.window}-${event.threshold}-${Date.now()}`, {
          type: 'basic',
          iconUrl: NOTIFICATION_ICON_URL,
          title: `OpenCode Go ${label} ${event.threshold}% 到達`,
          message: `${label} が ${event.usagePercent}% になりました。${event.threshold}% しきい値の通知は、リセットまで再送しません。残 ${formatResetIn(event.resetInSec)}。`,
          priority: event.threshold >= 100 ? 2 : 1,
        });
      }
    } catch { /* notifications may be declined */ }
  }
}

async function notifyAuthExpired() {
  try {
    await chrome.notifications.create(NOTIF_AUTH, {
      type: 'basic',
      iconUrl: NOTIFICATION_ICON_URL,
      title: 'OpenCode Go ログインが必要',
      message: 'opencode.ai のセッションが切れています。ダッシュボードを開いて再ログインしてください。',
      priority: 2,
    });
  } catch { /* ignore */ }
}

// Serialize concurrent poll() invocations (alarm + tabs.onUpdated + popup
// refresh can fire simultaneously). Without this, two polls racing on
// chrome.storage.local -> setState clobber each other and may emit duplicate
// pace notifications.
let pollInFlight = null;
async function poll() {
  if (pollInFlight) return pollInFlight;
  pollInFlight = (async () => await doPoll())();
  try {
    return await pollInFlight;
  } finally {
    pollInFlight = null;
  }
}

async function doPoll() {
  const state = await getState();
  let workspaceId = state.workspaceId;
  if (!workspaceId) {
    workspaceId = await discoverWorkspaceId();
    if (workspaceId) await setState({ workspaceId });
  }
  if (!workspaceId) {
    // No workspace configured and none visible. Clear the badge.
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'OpenCode Go Usage — opencode.ai の /workspace ページを開いてください' });
    await scheduleNextPoll(ADAPTIVE_POLL_MINUTES.idle);
    return;
  }

  const res = await fetchDashboard(workspaceId);
  if (!res.ok) {
    if (res.authRequired) {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#e53935' });
      await chrome.action.setTitle({ title: 'OpenCode Go Usage — ログインが必要です' });
      await notifyAuthExpired();
    } else {
      await chrome.action.setBadgeText({ text: '?' });
      await chrome.action.setBadgeBackgroundColor({ color: '#777' });
      await chrome.action.setTitle({ title: `OpenCode Go Usage — 取得失敗: ${res.error || res.status}` });
    }
    await setState({ last: { at: Date.now(), ok: false, error: res.error || res.status, authRequired: !!res.authRequired } });
    await scheduleNextPoll(res.authRequired ? ADAPTIVE_POLL_MINUTES.idle : ADAPTIVE_POLL_MINUTES.fallback);
    return;
  }

  const parsed = parseUsageFromHtml(res.html);
  if (!parsed.ok) {
    await chrome.action.setBadgeText({ text: '?' });
    await chrome.action.setBadgeBackgroundColor({ color: '#777' });
    await chrome.action.setTitle({ title: 'OpenCode Go Usage — データ解析失敗(フォーマット変更?)' });
    await setState({ last: { at: Date.now(), ok: false, error: parsed.error } });
    await scheduleNextPoll(ADAPTIVE_POLL_MINUTES.fallback);
    return;
  }

  const windows = parsed.windows;
  const now = Date.now();
  const planned = planUsageNotifications({
    lastNotif: state.lastNotif,
    workspaceId,
    previousWindows: state.last?.windows,
    windows,
    now,
  });
  const nextPollMin = nextAdaptivePollMinutes(state.last?.windows, windows);
  await updateBadge(windows.monthly);
  await setState({
    workspaceId,
    lastNotif: planned.lastNotif,
    nextPollMin,
    nextPollAt: now + nextPollMin * 60 * 1000,
    last: {
      at: now,
      ok: true,
      windows,
      finalUrl: res.finalUrl,
    },
  });
  await scheduleNextPoll(nextPollMin);
  await emitUsageNotifications(planned.events);
}

// --- lifecycle ---

chrome.runtime.onInstalled.addListener(async () => {
  await poll();
});

chrome.runtime.onStartup?.addListener(() => {
  // Return the promise so the runtime keeps the worker alive for the fetch+parse.
  return poll();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== ALARM_NAME) return;
  // Keep the worker alive for the duration of the fetch+parse: return the
  // promise so the runtime tracks pending async work.
  return poll();
});

// When the user navigates to a workspace page (or opens one), treat it as a
// fresh discovery + immediate refresh so the badge updates quickly.
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status !== 'complete') return;
  const ws = String(tab.url || '').match(/\/workspace\/([^/?#]+)/);
  if (!ws) return;
  // Return the promise so the runtime keeps the worker alive through the fetch+parse.
  return (async () => {
    const state = await getState();
    if (state.workspaceId !== ws[1]) {
      await setState({ workspaceId: ws[1] });
    }
    await poll();
  })();
});

// Manual refresh from the popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'refresh') {
    poll().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async
  }
  if (msg && msg.type === 'set-workspace' && typeof msg.workspaceId === 'string') {
    setState({ workspaceId: msg.workspaceId }).then(() => {
      poll().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    });
    return true;
  }
  return false;
});