# Discord Browser Orb Farmer

A browser extension (Manifest V3) for **Chrome/Chromium and Safari** that automates **video quests** on `discord.com/quest-home` to earn Discord Orbs without clicking through them by hand.

![Status](https://img.shields.io/badge/status-beta-orange)
![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Safari-blue)
![Manifest](https://img.shields.io/badge/manifest-v3-green)

> [!CAUTION]
> **Discord enforces against quest automation, in the browser as well as in the desktop app.**
> Since April 2026 accounts have received system messages and **Quest Access suspensions** (reported as roughly 10 to 15 days) with the violation *"Inauthentic Quest Completion"*, reportedly recorded on the account's **Account Standing** too. Detection is server side: it looks at how quest progress arrives and at completion patterns, not at which client you use, so using `discord.com` instead of the Electron app does not avoid it.
> This extension really plays each video, but it still clicks for you, runs quests back to back and claims immediately, which is exactly the kind of pattern that gets flagged. **If you would mind losing quest access or getting a mark on the account, don't run it on that account.**

---

## What it does

Nothing happens until you press **Start** in the popup. Then it:

1. Navigates to `discord.com/quest-home` (and resumes automatically after the page load)
2. Scrolls to the **Available Quests** grid
3. Collects every **"Watch Xs"** button (video quests only)
4. Opens each quest's video modal and **follows the real `<video>` element** until it has actually finished (restarting it if it pauses)
5. If Discord shows its **"Are you human?"** captcha, pauses and asks **you** to solve it (it never tries to click or solve it)
6. Clicks **Claim Reward** once it unlocks
7. Dismisses the reward modal, reads the new Orb balance, and moves on
8. Rescans for lazy-loaded quest cards; quests that fail twice are skipped instead of looping forever

A popup shows live status, the real video progress, the Orb balance and an activity log.

---

## What it does NOT do

| Quest type | Supported? | Reason |
|---|---|---|
| Video quests (`Watch Xs` button) | ✅ Yes | Full automation |
| Play quests (`Play Now` / `Accept Quest`) | ❌ No | Requires a game process on the OS |
| Mobile-only quests | ❌ No | No Watch button in the browser client; they are listed in the log as skipped |
| Stream quests | ❌ No | Requires an actual Go Live session |

---

## Installation

### Chrome / Edge / Brave / Opera

> No build step required. Load the `extension/` folder directly.

1. Clone or download this repo
2. Open `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `extension/` folder

### Safari (macOS)

Safari extensions must be wrapped in a small macOS app. The Xcode project in `safari/` is already generated and points at the same `extension/` folder, so there is a single source.

Requirements: macOS 12+, Safari 15.4+, Xcode.

1. Build it:
   ```bash
   scripts/build-safari.sh --open
   ```
   (or open `safari/Discord Orb Collector/Discord Orb Collector.xcodeproj` in Xcode and press ▶)
2. The build is ad-hoc signed, so Safari has to accept unsigned extensions:
   **Safari → Settings → Advanced → Show features for web developers**, then **Safari → Settings → Developer → Allow unsigned extensions**.
   This setting resets every time Safari quits; re-enable it after a restart.
3. **Safari → Settings → Extensions**, tick **Discord Orb Collector**.
4. Open `discord.com`, click the extension icon and allow it on **discord.com** (*Always Allow on This Website*).
   Without this permission the popup reports *"Content script not responding"*.

To regenerate the Xcode project from scratch (e.g. after adding a file to `extension/`):

```bash
xcrun safari-web-extension-converter extension --project-location safari --app-name "Discord Orb Collector" --bundle-identifier com.brayanofficiel.DiscordOrbCollector --swift --macos-only --no-open --force
```

Then check that the app's `PRODUCT_BUNDLE_IDENTIFIER` is `com.brayanofficiel.DiscordOrbCollector` (the converter writes a dashed one that doesn't match the extension's and breaks the build).

---

## Usage

1. Click the extension icon
2. Click **Open Quests** to go to `discord.com/quest-home` (optional: Start navigates there itself)
3. Click **▶ Start**
4. **Keep the Discord tab visible.** Discord pauses the video in a background tab; the extension restarts it, but progress only counts while it plays
5. If the captcha appears, solve it in the Discord tab; the run resumes by itself
6. Click **■ Stop** at any time; it stops within a second

Open **DevTools → Console** on `discord.com` (Safari: **Develop → Show Web Inspector**) and filter by `[Orb Collector]` for step-by-step logs.

**Safari note:** Safari blocks video autoplay with sound when the click isn't a real user gesture. When that happens the extension plays the video muted.

---

## Configuration

Timing values are at the top of `extension/content.js`:

```js
const CONFIG = {
  VIDEO_FALLBACK_MS:         3 * 60 * 1000, // only if no <video> and no timestamp is found
  VIDEO_DETECT_TIMEOUT_MS:   8000,          // how long to look for the video after the modal opens
  VIDEO_DONE_RATIO:          0.98,          // fraction of the video that counts as finished
  POST_VIDEO_GRACE_MS:       3000,          // grace period after the video ends
  ELEMENT_TIMEOUT_MS:        15000,         // max wait for DOM elements
  CLAIM_TIMEOUT_MS:          30000,         // max wait for Claim Reward to unlock
  CAPTCHA_MANUAL_TIMEOUT_MS: 5 * 60 * 1000, // max wait for you to solve the captcha
  JITTER_MIN_MS:             2000,          // pause between quests
  JITTER_MAX_MS:             4500,
  MAX_ATTEMPTS_PER_QUEST:    2,             // then the quest is skipped
};
```

---

## Known Issues

See [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) for details.

| # | Issue | Status |
|---|---|---|
| 1 | Video may not play the full duration | Fixed in 1.2.0 |
| 2 | Mobile-only quests are invisible | Can't fix; now listed as skipped |
| 3 | hCaptcha auto-click | Removed: you solve the captcha |
| 4 | Video duration parse fails | Fixed in 1.2.0 |
| 5 | Claim Reward poll times out | Mitigated (30 s, clearer errors) |
| 6 | Orb balance shows `—` | Fixed in 1.2.0 |
| 7 | Runs/redirects on every discord.com page | Fixed in 1.2.0 |

---

## Project structure

```
extension/              The extension (shared by Chrome and Safari)
├── manifest.json
├── content.js          Automation logic + popup bridge
├── popup.html / .js    Popup UI
└── icons/
safari/                 Xcode project wrapping extension/ for Safari (macOS)
scripts/build-safari.sh Builds the Safari app (ad-hoc signed)
```

---

## Compatibility

- Chrome 102+ / any Chromium-based browser (Edge, Brave, Opera)
- Safari 15.4+ on macOS 12+
- Discord web client at `discord.com` (not the desktop app)

---

## Legal / ToS notice

This tool automates interactions with Discord's quest system and goes against Discord's Terms of Service. See the caution at the top. Use at your own risk; the authors are not responsible for any action Discord takes on your account.

---

## License

MIT
