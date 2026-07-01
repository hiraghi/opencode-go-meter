// popup.mjs — renders bars + daily-budget summary, talks to the background worker.

import {
  LIMITS,
  budgetForWindow,
  severityForPace,
  expectedPercentForWindow,
  formatResetIn,
} from './src/usage.mjs';

const STORAGE_KEY = 'state';

const statusEl = document.getElementById('status');
const barsEl = document.getElementById('bars');
const updatedEl = document.getElementById('updated');
const refreshBtn = document.getElementById('refresh');
const wsInput = document.getElementById('ws-input');
const wsSave = document.getElementById('ws-save');

const WINDOW_LABEL = {
  rolling: 'ローリング(5h)',
  weekly: '週間(7d)',
  monthly: '月間(30d)',
};

function fmtTimeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  return `${Math.floor(s / 3600)}時間前`;
}

function renderWindows(windows) {
  barsEl.innerHTML = '';
  const names = ['rolling', 'weekly', 'monthly'];
  for (const name of names) {
    const w = windows[name];
    if (!w) continue;
    const win = LIMITS[name];
    const b = budgetForWindow(name, w.usagePercent, w.resetInSec);
    const sev = severityForPace(b.pacePct, b.dailyAllowancePct);
    const expected = b.expectedPct;

    const card = document.createElement('div');
    card.className = 'bar';

    // Build DOM with createElement/textContent — no innerHTML interpolation,
    // so nothing can become markup even if some value is ever non-numeric.
    const head = document.createElement('div');
    head.className = 'head';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'label';
    labelSpan.textContent = WINDOW_LABEL[name];
    const pctSpan = document.createElement('span');
    pctSpan.className = 'pct';
    pctSpan.textContent = `${w.usagePercent}%`;
    head.appendChild(labelSpan);
    head.appendChild(pctSpan);
    card.appendChild(head);

    const track = document.createElement('div');
    track.className = 'track';
    const fill = document.createElement('div');
    fill.className = `fill ${sev}`;
    fill.style.width = `${Math.min(100, Math.max(0, w.usagePercent))}%`;
    const marker = document.createElement('div');
    marker.className = 'marker';
    marker.setAttribute('title', '経過時間マーカー');
    marker.style.left = `${Math.min(100, Math.max(0, expected))}%`;
    track.appendChild(fill);
    track.appendChild(marker);
    card.appendChild(track);

    const reset = document.createElement('div');
    reset.className = 'reset';
    reset.textContent = `リセットまで ${formatResetIn(w.resetInSec)}`;
    card.appendChild(reset);

    const remainText =
      b.remainingPct >= 0
        ? `今あと ${b.remainingPct.toFixed(1)}%`
        : `ペース+${Math.abs(b.remainingPct).toFixed(1)}%`;
    const summary = document.createElement('div');
    summary.className = 'summary';
    const sumLeft = document.createElement('span');
    sumLeft.textContent = name === 'monthly'
      ? `${b.elapsedDayIndex}/30日目 許容 ${expected.toFixed(1)}%`
      : `日割り想定 ${Math.round(expected)}% / 1日 ${b.dailyAllowancePct.toFixed(2)}%`;
    const sumRight = document.createElement('span');
    sumRight.className = `remaining ${sev}`;
    sumRight.textContent = remainText;
    summary.appendChild(sumLeft);
    summary.appendChild(sumRight);
    card.appendChild(summary);

    barsEl.appendChild(card);
  }
}

function renderError(msg) {
  statusEl.classList.add('error');
  statusEl.textContent = msg;
  barsEl.innerHTML = '';
  updatedEl.textContent = '';
}

async function load() {
  const v = await chrome.storage.local.get(STORAGE_KEY);
  const state = v[STORAGE_KEY] || {};
  statusEl.classList.remove('error');
  statusEl.textContent = '';
  if (wsInput && state.workspaceId) wsInput.value = state.workspaceId;

  const last = state.last;
  if (!last) {
    renderError('まだデータを取得していません。opencode.ai のワークスペースページを開くか、↻ を押してください。');
    return;
  }
  if (!last.ok) {
    if (last.authRequired) {
      renderError('ログインが必要です。opencode.ai を開いてサインインしてください。');
    } else {
      renderError(`取得に失敗しました: ${last.error || ''}`);
    }
    updatedEl.textContent = fmtTimeAgo(last.at);
    return;
  }
  if (!last.windows) {
    renderError('データがありません');
    return;
  }
  renderWindows(last.windows);
  updatedEl.textContent = `最終取得: ${fmtTimeAgo(last.at)}${state.workspaceId ? ' ・ ws ' + state.workspaceId : ''}`;
}

refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  statusEl.classList.remove('error');
  statusEl.textContent = '更新中...';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'refresh' });
    if (res && res.ok) {
      await load();
    } else {
      await load();
      statusEl.classList.add('error');
      statusEl.textContent = '更新エラー';
    }
  } catch (e) {
    statusEl.classList.add('error');
    statusEl.textContent = '更新エラー: ' + String(e);
  } finally {
    refreshBtn.disabled = false;
  }
});

wsSave.addEventListener('click', async () => {
  const id = wsInput.value.trim();
  if (!/^wrk_[A-Z0-9]+$/i.test(id)) {
    statusEl.classList.add('error');
    statusEl.textContent = 'ワークスペースIDは wrk_... 形式で入力してください。';
    return;
  }
  wsSave.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'set-workspace', workspaceId: id });
    await load();
    if (!res || !res.ok) {
      statusEl.classList.add('error');
      statusEl.textContent = 'ワークスペース設定エラー';
    }
  } finally {
    wsSave.disabled = false;
  }
});

document.addEventListener('DOMContentLoaded', load);