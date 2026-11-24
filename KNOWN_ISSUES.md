# Known Issues

Confirmed bugs, limitations and edge cases, with their status as of **1.2.0**.

---

## Issue 1 — Video does not play the full duration before claiming

**Status:** Fixed in 1.2.0

The extension used to sleep for a duration read once from the `0:01 / 0:37` text, so a video that buffered or paused (e.g. tab in the background) was claimed before Discord had registered the watch.

**Fix:** `watchVideo()` now follows the real `<video>` element: it waits for `ended` or `currentTime >= duration × 0.98`, restarts playback if the video pauses or stalls, updates the popup with real progress, and warns when the tab is hidden. Wall-clock waiting is only used when no `<video>` can be found at all.

**Still true:** keep the Discord tab visible. Browsers throttle background tabs and Discord pauses the player there.

---

## Issue 2 — Mobile-only quests are not processed

**Status:** By design (can't fix in a browser extension); now reported

Discord gates some video quests to the mobile client. The browser renders the card without a Watch button.

**Change:** cards that say "watch the video" but have no Watch button (and aren't already claimed) are listed in the activity log as *"Skipped (mobile-only?)"*. This is a text heuristic and may miss some cards. Complete them in the mobile app.

---

## Issue 3 — hCaptcha checkpoint

**Status:** Changed in 1.2.0: the extension no longer clicks the captcha

The old code dispatched a synthetic click at the hCaptcha iframe. That could not work (a script-generated event is not delivered into a cross-origin iframe, and hCaptcha ignores untrusted events), and the captcha is Discord's anti-automation checkpoint anyway.

**Behaviour now:** when the captcha appears (after the video or while waiting for Claim), the run pauses, a red banner is shown in the page and the popup shows *"Solve the captcha in the Discord tab"*. Once you solve it the run continues. After 5 minutes without a solve the run stops with an error.

---

## Issue 4 — Video duration parse fails on some quest formats

**Status:** Fixed in 1.2.0

The duration now comes from `video.duration` first. The text fallback is scoped to the open modal, requires the full `M:SS / M:SS` form (the old regex could match any `/ 1:23` on the page), and is retried for up to 8 s while the player renders.

---

## Issue 5 — Claim Reward poll times out if Discord is slow

**Status:** Mitigated in 1.2.0

The timeout is now `CLAIM_TIMEOUT_MS` (30 s), and the log distinguishes *"button not found"* from *"button stayed locked — Discord did not register the watch"*. A skipped quest's modal is closed, and a quest is retried at most `MAX_ATTEMPTS_PER_QUEST` times instead of being re-queued forever.

---

## Issue 6 — Orb balance shows "—" in the popup

**Status:** Fixed in 1.2.0

The balance is parsed from the reward modal text ("Your Orbs balance is now 1,400.") with a regex that tolerates thousands separators and trailing punctuation; the old one required the number to be the last character. The header counter is only a fallback.

---

## Issue 7 — Extension ran (and redirected) on every discord.com page

**Status:** Fixed in 1.2.0

`main()` ran on every page load, so simply opening any Discord channel redirected to `/quest-home` and started the automation without pressing Start.

**Fix:** nothing runs until Start is pressed. If you press Start elsewhere on Discord, the extension stores a short-lived flag, navigates to `/quest-home`, and resumes there.

---

## Other bugs fixed in 1.2.0

- **Stop did nothing:** `STATE.stopped` was set but never read; the loop kept going. Every wait now checks it, so Stop takes effect within ~250 ms.
- **Popup HTML injection:** log lines and the quest title (text taken from the Discord page) were inserted with `innerHTML` into the extension's popup. Everything now uses `textContent`.
- **Duplicate queue entries:** a Watch `<button>` and its inner `[class*=button]` div were queued as two quests.
- **Infinite loop on a quest that never unlocks:** the rescan re-added the same Watch button indefinitely.
- **Two runs at once:** pressing Start while the page-load run was in progress started a second loop.
- **Unhandled promise rejections** in the console every time the popup was closed.
- **UTF-8 BOM** at the start of every file (including `manifest.json`), which some tools — Safari's converter included — reject.
- **Unused `scripting` permission** removed.

---

## Safari-specific notes

- The extension must be allowed on `discord.com` in Safari (click the extension icon on the page → *Always Allow on This Website*), otherwise the popup says *"Content script not responding"*.
- Safari blocks autoplay with sound for script-initiated playback; the extension falls back to muted playback.
- Ad-hoc signed builds need **Allow unsigned extensions**, which Safari resets on every restart.
