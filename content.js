// content.js — augments the native OpenCode Go usage UI.
//
// The extension no longer injects a duplicate three-card meter. Instead it reads
// the dashboard's embedded usage data, adds today's prorated monthly allowance
// below the native monthly reset text, and (best effort) draws a vertical marker
// on the native monthly usage bar.
//
// MV3 content scripts are classic scripts; we load the ES module via dynamic
// import() from a web_accessible_resource.

(() => {
  const URL = chrome.runtime.getURL('src/usage.mjs');

  function parseWindowsFromDoc(usage) {
    const r = usage.parseUsageFromHtml(document.documentElement.outerHTML);
    return r.ok ? r.windows : null;
  }

  function clampPct(v) {
    return Math.min(100, Math.max(0, v));
  }

  function textOf(node) {
    return String(node?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function smallEnoughForUsageCard(el) {
    const r = el.getBoundingClientRect();
    return r.width >= 160 && r.width <= Math.max(900, window.innerWidth) && r.height >= 40 && r.height <= 420;
  }

  function isMonthlyText(t) {
    const s = String(t).toLowerCase();
    return s.includes('monthly') || s.includes('月間');
  }

  function findSmallestMonthlyContainer(monthly) {
    const percentText = `${monthly.usagePercent}%`;
    const nativeItem = Array.from(document.querySelectorAll('[data-slot="usage-item"]'))
      .find((el) => isMonthlyText(textOf(el)) && smallEnoughForUsageCard(el));
    if (nativeItem) return nativeItem;

    const candidates = Array.from(document.querySelectorAll('section, article, div, li'))
      .filter((el) => {
        if (el.id === 'ocgo-meter' || el.closest('#ocgo-meter')) return false;
        const t = textOf(el);
        return isMonthlyText(t) && t.includes(percentText) && smallEnoughForUsageCard(el);
      })
      .sort((a, b) => (a.textContent.length - b.textContent.length) || (a.getBoundingClientRect().height - b.getBoundingClientRect().height));
    if (candidates[0]) return candidates[0];

    const fallback = Array.from(document.querySelectorAll('section, article, div, li'))
      .filter((el) => {
        if (el.id === 'ocgo-meter' || el.closest('#ocgo-meter')) return false;
        const t = textOf(el);
        return isMonthlyText(t) && /reset|リセット|usage|利用|\d+\s*%/.test(t) && smallEnoughForUsageCard(el);
      })
      .sort((a, b) => (a.textContent.length - b.textContent.length) || (a.getBoundingClientRect().height - b.getBoundingClientRect().height));
    return fallback[0] || null;
  }

  function findResetElement(container) {
    if (!container) return null;
    const candidates = Array.from(container.querySelectorAll('*'))
      .filter((el) => {
        if (el.children.length > 3) return false;
        const t = textOf(el).toLowerCase();
        return /reset|リセット/.test(t) && t.length <= 100;
      })
      .sort((a, b) => textOf(a).length - textOf(b).length);
    return candidates[0] || null;
  }

  function findNativeTrack(container, monthly) {
    if (!container) return null;

    const nativeTrack = container.querySelector('[data-slot="progress"]');
    if (nativeTrack && nativeTrack.getBoundingClientRect().width > 80) return nativeTrack;

    const role = container.querySelector('[role="progressbar"], [aria-valuenow]');
    if (role && role.getBoundingClientRect().width > 80) return role;

    const pct = String(monthly.usagePercent);
    const fills = Array.from(container.querySelectorAll('*')).filter((el) => {
      const style = el.getAttribute('style') || '';
      if (!new RegExp(`(?:width|inline-size)\\s*:\\s*${pct}(?:\\.0+)?%`, 'i').test(style)) return false;
      const r = el.getBoundingClientRect();
      const p = el.parentElement?.getBoundingClientRect();
      return r.width > 0 && r.height >= 3 && r.height <= 28 && p && p.width >= 80 && p.height >= 3 && p.height <= 36;
    });
    return fills[0]?.parentElement || null;
  }

  function pageIsJapanese() {
    const lang = document.documentElement.lang || '';
    if (lang.toLowerCase().startsWith('ja')) return true;
    return /月間利用量|リセットまで/.test(document.body?.textContent || '');
  }

  function allowanceText(budget, ja) {
    const remaining = Math.abs(budget.remainingPct).toFixed(1);
    const allowance = budget.expectedPct.toFixed(1);
    if (ja) {
      return budget.remainingPct < 0
        ? `今日の許容超過: ${remaining}%（${budget.elapsedDayIndex}/30日目・許容 ${allowance}%）`
        : `今日の残り許容: ${remaining}%（${budget.elapsedDayIndex}/30日目・許容 ${allowance}%）`;
    }
    return budget.remainingPct < 0
      ? `Over today's allowance: ${remaining}% (day ${budget.elapsedDayIndex}/30 · allowance ${allowance}%)`
      : `Remaining allowance today: ${remaining}% (day ${budget.elapsedDayIndex}/30 · allowance ${allowance}%)`;
  }

  function allowanceTitle(budget, ja) {
    return ja
      ? `月間の許容ライン: 30日中 ${budget.elapsedDayIndex}日目 = ${budget.expectedPct.toFixed(2)}% / 使用 ${budget.usagePercent}%`
      : `Monthly allowance line: day ${budget.elapsedDayIndex}/30 = ${budget.expectedPct.toFixed(2)}% / used ${budget.usagePercent}%`;
  }

  function ensureNote(container, resetEl, budget, usage) {
    const note = document.createElement('div');
    note.id = 'ocgo-monthly-allowance';
    const over = budget.remainingPct < 0;
    const ja = pageIsJapanese();
    note.className = `ocgo-site-note ${over ? 'ocgo-over' : 'ocgo-healthy'}`;
    note.textContent = allowanceText(budget, ja);
    note.title = allowanceTitle(budget, ja);

    const old = document.getElementById('ocgo-monthly-allowance');
    if (old) old.remove();

    if (resetEl && resetEl.parentElement) {
      resetEl.insertAdjacentElement('afterend', note);
    } else {
      container.appendChild(note);
    }
  }

  function ensureMarker(track, expectedPct) {
    const oldMarkers = document.querySelectorAll('.ocgo-site-marker');
    oldMarkers.forEach((n) => n.remove());
    if (!track) return;

    track.classList.add('ocgo-site-track');
    const computed = getComputedStyle(track);
    if (computed.position === 'static') track.style.position = 'relative';

    const marker = document.createElement('div');
    marker.className = 'ocgo-site-marker';
    marker.title = pageIsJapanese()
      ? `今日時点の許容利用量 ${expectedPct.toFixed(1)}%`
      : `Allowance as of today ${expectedPct.toFixed(1)}%`;
    marker.style.left = `${clampPct(expectedPct)}%`;
    track.appendChild(marker);
  }

  function removeLegacyMeter() {
    document.getElementById('ocgo-meter')?.remove();
  }

  function augment(windows, usage) {
    removeLegacyMeter();
    const monthly = windows?.monthly;
    if (!monthly) return;
    const budget = usage.budgetForWindow('monthly', monthly.usagePercent, monthly.resetInSec);
    const container = findSmallestMonthlyContainer(monthly);
    if (!container) return;
    const resetEl = findResetElement(container);
    ensureNote(container, resetEl, budget, usage);
    ensureMarker(findNativeTrack(container, monthly), budget.expectedPct);
  }

  async function init() {
    let usage;
    try {
      usage = await import(URL);
    } catch (e) {
      console.warn('[opencode-go-meter] failed to load usage.mjs', e);
      return;
    }

    const run = () => {
      const windows = parseWindowsFromDoc(usage);
      if (windows) augment(windows, usage);
    };

    run();
    setTimeout(run, 2000);
    setTimeout(run, 5000);
  }

  init();
})();
