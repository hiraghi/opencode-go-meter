# OpenCode Go Usage Meter (Chrome Extension)

[日本語](README.ja.md)

A Manifest V3 Chrome extension that adds **daily-budget context** to your OpenCode Go
plan usage. It shows Rolling Usage / Weekly Usage / Monthly Usage in the popup,
and augments the native Monthly Usage card by adding a **Remaining allowance today**
or **Over today's allowance** line under the site's **Resets in** text, plus a
best-effort vertical allowance marker on the native monthly usage bar — for **any**
opencode.ai workspace.

## Why

OpenCode Go limits are defined in dollar value ($12/5h, $30/week, $60/30d) but the
dashboard only shows the current % and "resets in". It does not tell you whether
your pace is sustainable to month-end. This extension computes the prorated
expected usage and shows the headroom, so you can see at a glance whether you're
running hot.

## Authentication

There is **no public usage API** for OpenCode Go (issues #16017 / #31084 are open).
The dashboard embeds the data in an inline `<script>` (SolidJS streaming
hydration). This extension simply `fetch`es the dashboard HTML with
`credentials: 'include'` so the user's existing Chrome login session is reused —
**zero configuration, no token to paste, no cookies to extract.** It works for any
logged-in opencode.ai account.

## Install

1. `git clone` this repo (or download as zip).
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** → select this folder.
5. Open `https://opencode.ai/workspace/<your-workspace-id>/go`.
   The workspace id is auto-detected from the URL and the badge updates. The page
   keeps the native OpenCode meters; the extension adds only the monthly allowance
   text/marker instead of duplicating the whole meter UI.
6. Click the toolbar icon to open the popup with the three bars + daily-budget
   summary.

The toolbar badge shows the **monthly usage %**, colored by pace:
green (on/under pace) / amber / red.

## How the monthly allowance works

The monthly meter is prorated across 30 days up to today. The extension shows the usage percentage you can allow yourself as of today, then compares it with the current monthly usage.

For example, if today's allowance is 3.3% and the dashboard shows 4% Monthly Usage, the page displays a small `Over today's allowance` message under the native `Resets in` text.

## Notifications

The background service worker polls while Chrome is running, when a workspace tab finishes loading, and when the popup requests a manual refresh. The regular background interval is adaptive based on 5h Rolling Usage: 1 hour at 0%, 5 minutes after usage increases, and 30 minutes when usage is unchanged.

Notifications are emitted for:
- monthly usage above today's prorated allowance: at most once per local date;
- 5h rolling usage reaching 50%, 75%, or 100%: once per threshold until reset;
- weekly rolling usage reaching 50%, 75%, or 100%: once per threshold until reset;
- auth expiry: when dashboard fetch redirects to login.

### Caveat: near reset boundaries

Right after a reset, even small usage can appear ahead of the prorated pace. The popup shows the reset countdown next to the meter so the context is visible.

## Privacy & security

- Single network destination: `opencode.ai` only.
- No token/cookie storage; the Chrome session is reused via `credentials:'include'`.
- Workspace IDs are discovered from the active tab URL or entered manually, then stored in `chrome.storage.local` only.
- Read-only; the extension does not modify OpenCode data or send usage data to any third-party service.

## License

MIT. See [LICENSE](LICENSE).

Not affiliated with OpenCode / Anomaly. "OpenCode Go" is a trademark of its
owners, used here only for descriptive compatibility.