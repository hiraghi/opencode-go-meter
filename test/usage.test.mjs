// test/usage.test.mjs — validates parse + budget math against the real
// captured dashboard <script> snippet (from a 2026-07-01 Playwright session).
// Run:  node --test test/usage.test.mjs
// (Or:  node test/usage.test.mjs   on Node w/o the test runner.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUsageFromHtml,
  budgetForWindow,
  expectedPercentForWindow,
  severityForPace,
  workspaceIdFromUrl,
  formatResetIn,
  LIMITS,
  planUsageNotifications,
  nextAdaptivePollMinutes,
  ADAPTIVE_POLL_MINUTES,
} from '../src/usage.mjs';

// Real inline-script shape captured from the OpenCode Go dashboard, with all
// workspace-specific identifiers replaced by a synthetic fixture id.
const REAL_HTML = `
self.$R=self.$R||[];_$HY.r["userEmail[\\"wrk_EXAMPLE_WORKSPACE\\"]"]=$R[0]=($R[2]=r=>(r.p=new Promise((s,f)=>{r.s=s,r.f=f})))($R[1]={p:0,s:0,f:0});
_$HY.r["lite.subscription.get[\\"wrk_EXAMPLE_WORKSPACE\\"]"]=$R[17]=$R[2]($R[18]={p:0,s:0,f:0});
($R[28]=(r,d)=>{r.s(d),r.p.s=1,r.p.v=d})($R[18],$R[34]={mine:!0,useBalance:!1,region:$R[35]=["us","eu","sg"],rollingUsage:$R[36]={status:"ok",resetInSec:10833,usagePercent:47},weeklyUsage:$R[37]={status:"ok",resetInSec:436820,usagePercent:20},monthlyUsage:$R[38]={status:"ok",resetInSec:2066,usagePercent:60}});
`;

test('parseUsageFromHtml extracts all three windows from real HTML', () => {
  const r = parseUsageFromHtml(REAL_HTML);
  assert.ok(r.ok, 'parse should succeed');
  assert.equal(r.windows.rolling.usagePercent, 47);
  assert.equal(r.windows.rolling.resetInSec, 10833);
  assert.equal(r.windows.weekly.usagePercent, 20);
  assert.equal(r.windows.weekly.resetInSec, 436820);
  assert.equal(r.windows.monthly.usagePercent, 60);
  assert.equal(r.windows.monthly.resetInSec, 2066);
  assert.equal(r.windows.useBalance, false);
});

test('parseUsageFromHtml returns !ok on empty / login page', () => {
  assert.equal(parseUsageFromHtml('').ok, false);
  assert.equal(parseUsageFromHtml('<html><body>Continue with GitHub</body></html>').ok, false);
});

test('expectedPercentForWindow: monthly near-reset ≈ 99.92%', () => {
  // 30d window = 2592000s; resetInSec=2066 -> elapsed = 1 - 2066/2592000
  const e = expectedPercentForWindow('monthly', 2066);
  assert.ok(Math.abs(e - 99.9202) < 0.01, `got ${e}`);
});

test('budgetForWindow: monthly uses integer day bucket, near-reset -> day 30 / 100%', () => {
  const b = budgetForWindow('monthly', 60, 2066);
  assert.equal(b.elapsedDayIndex, 30);
  assert.equal(b.expectedPct, 100);
  assert.equal(b.remainingPct, 40);
  assert.equal(b.dailyAllowancePct, 100 / 30); // 3.333...
  assert.ok(b.pacePct < 0);
  assert.equal(severityForPace(b.pacePct, b.dailyAllowancePct), 'healthy');
});

test('budgetForWindow: weekly 20% / 436820s -> expected ~27.99, under pace', () => {
  const b = budgetForWindow('weekly', 20, 436820);
  // 7d = 604800; elapsed = 1 - 436820/604800 = 0.2778 -> 27.78%
  assert.ok(Math.abs(b.expectedPct - 27.78) < 0.05, `got ${b.expectedPct}`);
  assert.ok(b.pacePct < 0);
  assert.equal(severityForPace(b.pacePct, b.dailyAllowancePct), 'healthy');
});

test('budgetForWindow: rolling 47% / 10833s -> expected ~39.81, OVER pace (warn/red)', () => {
  // 5h = 18000; elapsed = 1 - 10833/18000 = 0.3982 -> 39.82%
  const b = budgetForWindow('rolling', 47, 10833);
  assert.ok(Math.abs(b.expectedPct - 39.82) < 0.05, `got ${b.expectedPct}`);
  assert.ok(b.pacePct > 0);
  // pace = 47 - 39.82 = 7.18; dailyAllowance (per-hour for 5h) = 100/(5/24)=480
  // so 7.18 < 480 -> warn
  assert.equal(severityForPace(b.pacePct, b.dailyAllowancePct), 'warn');
});

test('budgetForWindow: just-reset monthly is treated as day 1 / 3.33%', () => {
  const b = budgetForWindow('monthly', 5, 2591999);
  assert.equal(b.elapsedDayIndex, 1);
  assert.equal(b.expectedPct, 100 / 30);
  assert.ok(Math.abs(b.remainingPct - ((100 / 30) - 5)) < 0.0001);
  assert.equal(severityForPace(b.pacePct, b.dailyAllowancePct), 'warn');
});

test('workspaceIdFromUrl extracts id from various url shapes', () => {
  assert.equal(workspaceIdFromUrl('https://opencode.ai/workspace/wrk_ABC123/go'), 'wrk_ABC123');
  assert.equal(workspaceIdFromUrl('https://opencode.ai/workspace/wrk_ABC123/usage?x=1'), 'wrk_ABC123');
  assert.equal(workspaceIdFromUrl('https://opencode.ai/docs/go/'), null);
});

test('formatResetIn produces human strings', () => {
  assert.equal(formatResetIn(45), '45秒');
  assert.equal(formatResetIn(600), '10分');
  assert.equal(formatResetIn(5400), '1時間 30分');
  assert.equal(formatResetIn(90000), '1日 1時間');
});

test('LIMITS match official dollar caps', () => {
  assert.equal(LIMITS.rolling.usd, 12);
  assert.equal(LIMITS.weekly.usd, 30);
  assert.equal(LIMITS.monthly.usd, 60);
  assert.equal(LIMITS.rolling.windowSec, 18000);
  assert.equal(LIMITS.weekly.windowSec, 604800);
  assert.equal(LIMITS.monthly.windowSec, 2592000);
});

test('budgetForWindow exposes monthly integer day index for allowance text', () => {
  const b = budgetForWindow('monthly', 10, 15 * 86400);
  assert.equal(b.elapsedDays, 15);
  assert.equal(b.elapsedDayIndex, 15);
  assert.equal(b.expectedPct, 50);
  assert.equal(b.remainingPct, 40);
  const firstDay = budgetForWindow('monthly', 4, 2583418);
  assert.equal(firstDay.elapsedDayIndex, 1);
  assert.equal(firstDay.expectedPct, 100 / 30);
});

test('planUsageNotifications: monthly over is once per local date', () => {
  const windows = {
    monthly: { usagePercent: 20, resetInSec: 27 * 86400 }, // expected=10%, over by 10
    rolling: { usagePercent: 10, resetInSec: 1000 },
    weekly: { usagePercent: 10, resetInSec: 1000 },
  };
  const first = planUsageNotifications({ workspaceId: 'wrk_TEST', windows, now: new Date('2026-07-01T10:00:00').getTime() });
  assert.equal(first.events.filter(e => e.type === 'monthly-over').length, 1);
  const second = planUsageNotifications({ lastNotif: first.lastNotif, workspaceId: 'wrk_TEST', windows, now: new Date('2026-07-01T11:00:00').getTime() });
  assert.equal(second.events.filter(e => e.type === 'monthly-over').length, 0);
  const nextDay = planUsageNotifications({ lastNotif: first.lastNotif, workspaceId: 'wrk_TEST', windows, now: new Date('2026-07-02T10:00:00').getTime() });
  assert.equal(nextDay.events.filter(e => e.type === 'monthly-over').length, 1);
});

test('planUsageNotifications: rolling thresholds are sent once until reset countdown advances', () => {
  const windows = {
    monthly: { usagePercent: 1, resetInSec: 29 * 86400 },
    rolling: { usagePercent: 76, resetInSec: 1000 },
    weekly: { usagePercent: 10, resetInSec: 1000 },
  };
  const first = planUsageNotifications({ workspaceId: 'wrk_TEST', previousWindows: null, windows, now: 1 });
  assert.deepEqual(first.events.filter(e => e.type === 'threshold').map(e => `${e.window}:${e.threshold}`), ['rolling:50', 'rolling:75']);

  const second = planUsageNotifications({ lastNotif: first.lastNotif, workspaceId: 'wrk_TEST', previousWindows: windows, windows: { ...windows, rolling: { usagePercent: 80, resetInSec: 900 } }, now: 2 });
  assert.equal(second.events.filter(e => e.type === 'threshold').length, 0);

  const afterReset = planUsageNotifications({ lastNotif: second.lastNotif, workspaceId: 'wrk_TEST', previousWindows: { ...windows, rolling: { usagePercent: 80, resetInSec: 10 } }, windows: { ...windows, rolling: { usagePercent: 51, resetInSec: 17000 } }, now: 3 });
  assert.deepEqual(afterReset.events.filter(e => e.type === 'threshold').map(e => `${e.window}:${e.threshold}`), ['rolling:50']);
});

test('nextAdaptivePollMinutes follows rolling usage activity', () => {
  assert.equal(nextAdaptivePollMinutes(null, { rolling: { usagePercent: 0 } }), ADAPTIVE_POLL_MINUTES.idle);
  assert.equal(nextAdaptivePollMinutes(null, { rolling: { usagePercent: 1 } }), ADAPTIVE_POLL_MINUTES.active);
  assert.equal(nextAdaptivePollMinutes({ rolling: { usagePercent: 1 } }, { rolling: { usagePercent: 2 } }), ADAPTIVE_POLL_MINUTES.active);
  assert.equal(nextAdaptivePollMinutes({ rolling: { usagePercent: 2 } }, { rolling: { usagePercent: 2 } }), ADAPTIVE_POLL_MINUTES.unchanged);
  assert.equal(nextAdaptivePollMinutes({ rolling: { usagePercent: 2 } }, { rolling: { usagePercent: 0 } }), ADAPTIVE_POLL_MINUTES.idle);
});
