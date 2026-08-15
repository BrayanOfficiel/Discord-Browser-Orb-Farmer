# Discord Browser Orb Farmer

A Chrome extension (Manifest V3) that automates **video quests** on `discord.com/quest-home` to earn Discord Orbs without watching them manually.

![Status](https://img.shields.io/badge/status-beta-orange)
![Platform](https://img.shields.io/badge/platform-Chrome%20%2F%20Chromium-blue)
![Manifest](https://img.shields.io/badge/manifest-v3-green)

---

## What it does

1. Navigates to `discord.com/quest-home`
2. Scrolls to the **Available Quests** grid
3. Collects every **"Watch Xs"** button (video quests only)
4. Opens each quest's video modal and waits out the full duration
5. Handles the hCaptcha **"Are you human?"** checkpoint
6. Clicks **Claim Reward** once it unlocks
7. Dismisses the reward modal and loops to the next quest
8. Rescans for lazy-loaded quest cards between runs

A popup UI shows live status, a video progress bar, Orb balance, and an activity log.

---

## What it does NOT do

| Quest type | Supported? | Reason |
|---|---|---|
| Video quests (`Watch Xs` button) | ✅ Yes | Full automation |
| Play quests (`Play Now` / `Accept Quest`) | ❌ No | Requires game process on OS — outside browser scope |
| Mobile-only quests | ❌ No | Not rendered in the browser client at all |
| Stream quests | ❌ No | Requires an actual Go Live session |

For **play quests**, see [orbshacker](https://github.com/strykey/orbshacker) — a separate Windows CLI tool that fakes game processes. It cannot be integrated into a browser extension (different runtime layer entirely).

---

## Installation

> No build step required. Load the `extension/` folder directly.

1. Clone or download this repo
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `extension/` folder
5. Navigate to any `discord.com` page — the extension activates automatically

---

## Usage

1. Click the extension icon in your toolbar
2. Click **Open Quests** to navigate to `discord.com/quest-home`
3. Click **▶ Start** — the automation runs through all available video quests
4. Watch the popup for live progress (phase, video timer, Orb balance)
5. If a captcha appears and does not auto-clear, a red banner will prompt you to solve it manually — the automation resumes automatically once cleared
6. Click **■ Stop** at any time to halt after the current quest finishes

Open **DevTools → Console** on `discord.com` and filter by `[Orb Collector]` for detailed step-by-step logs.

---

## Configuration

All timing values are at the top of `extension/content.js`:

```js
const CONFIG = {
  VIDEO_FALLBACK_MS:       3 * 60 * 1000,  // fallback wait if duration can't be parsed
  POST_VIDEO_GRACE_MS:     3000,            // grace period after video ends
  ELEMENT_TIMEOUT_MS:      15000,           // max wait for any DOM element
  CAPTCHA_AUTO_TIMEOUT_MS: 30000,           // max wait for captcha to auto-clear
  JITTER_MIN_MS:           2000,            // min random delay between quests
  JITTER_MAX_MS:           4500,            // max random delay between quests
};
```

---

## Known Issues

See [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) for the full list with reproduction steps and workarounds.

**Summary of active issues:**

| # | Issue | Severity | Workaround |
|---|---|---|---|
| 1 | Video may not play the full duration | High | Increase `VIDEO_FALLBACK_MS` |
| 2 | Mobile-only quests are invisible to the extension | Medium | Complete on mobile manually |
| 3 | hCaptcha iframe click does not always register | Medium | Solve manually when prompted |
| 4 | Video duration parse fails on some quest formats | Low | Falls back to `VIDEO_FALLBACK_MS` |
| 5 | Claim Reward poll times out if Discord is slow | Low | Increase `ELEMENT_TIMEOUT_MS` |
| 6 | Orb balance scraper may show `—` | Low | Cosmetic only |

---

## Project structure

```
extension/
├── manifest.json     Chrome MV3 manifest
├── content.js        All automation logic (10-step flow + popup bridge)
├── popup.html        Extension popup UI
├── popup.js          Popup state management and content script messaging
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png

README.md
KNOWN_ISSUES.md
CONTRIBUTING.md
.gitignore
```

---

## Compatibility

- Chrome 88+ / any Chromium-based browser (Edge, Brave, Opera)
- Discord browser client at `discord.com` (not the desktop app)
- Manifest V3 — no background pages, no eval

---

## Legal / ToS notice

This tool automates interactions with Discord's quest system. Use at your own risk.

- Discord's Terms of Service prohibit automated access in certain contexts
- Discord has previously warned users about quest automation (as of April 2026)
- This project is provided for **educational and research purposes only**
- The authors are not responsible for any account action taken by Discord

---

## License

MIT