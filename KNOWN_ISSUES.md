# Known Issues

This document tracks confirmed bugs, limitations, and edge cases in the current version.
Each entry includes severity, reproduction steps, root cause analysis, and the best available workaround.

---

## Issue 1 — Video does not play the full duration before claiming

**Severity:** High  
**Status:** Open

### Symptom
The extension clicks Claim Reward before the video has actually finished playing, resulting in the claim either failing silently or Discord not registering the full watch. The "Claim Reward" button may appear to be unlocked before the video server-side completion event fires.

### Root cause
Discord tracks video watch progress server-side via events fired by the embedded video player. The extension waits based on the parsed timestamp duration (`0:01 / 0:37`) plus a 2-second buffer. However:
- The timestamp is read **once** immediately after the modal opens, before the video may have fully buffered
- If the video buffers or pauses mid-play (network hiccup, tab focus loss), the wall-clock wait completes but the actual watched percentage is lower
- Discord's server may require a higher percentage threshold than just elapsed time

### Workaround
Increase `POST_VIDEO_GRACE_MS` and the buffer in `waitForVideo` in `content.js`:
```js
VIDEO_FALLBACK_MS:   5 * 60 * 1000,  // use 5 min fallback instead of 3
POST_VIDEO_GRACE_MS: 8000,            // increase grace from 3s to 8s
```
Also make sure the Discord tab remains focused while the video plays — Discord pauses the video player when you switch away from the tab.

### Fix direction
- Poll `video.currentTime >= video.duration * 0.98` instead of wall-clock sleep
- Subscribe to the `<video>` element's `ended` event and only proceed once it fires
- Add a minimum wait of `video.duration * 1000 + 5000ms` regardless of the timestamp parse

---

## Issue 2 — Mobile-only quests are not detected or processed

**Severity:** Medium  
**Status:** By design / Won't fix in browser extension

### Symptom
Some quests (e.g. "Rewind Time with Zilean Quest — Watch the video to win 200 Orbs!") show a **"Watch Xm"** button on mobile Discord but show no Watch button on the desktop browser client. The extension skips these entirely because the button never appears in the DOM.

### Root cause
Discord gates certain video quests to the mobile client only. The desktop browser renders the same quest card without a Watch button — instead showing "Play Now" or nothing actionable. This is a Discord platform decision, not a DOM selector issue.

The extension correctly ignores these cards (there is no Watch button to click), but has no way to surface them as "skipped — mobile only" to the user.

### Workaround
Complete mobile-only quests on the Discord mobile app manually. These are typically short (under 2 minutes) and common with sponsored quests like League of Legends trailers.

### Fix direction
- Detect quest cards that have a video reward but no Watch button in the browser DOM
- Log these as "mobile-only — skipped" in the popup activity log so the user knows to complete them on mobile
- Could check for the absence of a Watch button while a "Claim X Orbs" label is present

---

## Issue 3 — hCaptcha iframe click does not always register the checkbox

**Severity:** Medium  
**Status:** Open

### Symptom
After the video ends, the "Are you human?" hCaptcha modal appears. The extension dispatches a click to the top-left corner of the hCaptcha iframe (where the checkbox is rendered), but the captcha does not always clear. The red manual-solve banner appears.

### Root cause
hCaptcha renders inside a **cross-origin iframe** — content scripts cannot reach the iframe's internal DOM. The extension clicks the iframe *element itself*, which routes the pointer event into the iframe document. This works when:
- hCaptcha's risk score is low (low-traffic sessions, fresh accounts)
- The checkbox renders at a predictable position

It fails when:
- hCaptcha escalates to an image challenge (full CAPTCHA grid)
- The iframe hasn't fully rendered its checkbox by the time the click fires
- The iframe position shifts due to Discord's modal layout

### Workaround
Solve the captcha manually when the red banner appears. The extension resumes automatically after the modal closes. The 1.5-second pre-click delay helps, but is not always sufficient.

### Fix direction
- Increase the pre-click sleep from 1500ms to 3000ms
- Retry the click up to 3 times with 2-second gaps before showing the manual banner
- Consider using `postMessage` into the iframe (may be blocked by CSP)

---

## Issue 4 — Video duration parse fails on some quest formats

**Severity:** Low  
**Status:** Open

### Symptom
`parseDuration()` returns the fallback value (`VIDEO_FALLBACK_MS = 3 minutes`) even when a video is playing. The console shows: `Duration unknown - using fallback`.

### Root cause
The function scans `document.body.innerText` for the pattern `/ M:SS` (e.g. `/ 0:37`). This can fail if:
- Discord's video player renders the timestamp inside a Shadow DOM or canvas element (not accessible via `innerText`)
- The timestamp uses a non-standard separator or format
- The modal hasn't fully rendered the timestamp when `parseDuration()` is called

The `<video>.duration` fallback also fails if the video element is inside a Shadow DOM or cross-origin frame.

### Workaround
The 3-minute fallback is generally safe — most video quests are under 2 minutes. If your quests are longer, increase `VIDEO_FALLBACK_MS` in `content.js`.

### Fix direction
- Add a retry loop: wait up to 5 seconds for the timestamp to appear before falling back
- Use a MutationObserver specifically on the modal to detect when the timestamp node appears
- Prefer `video.duration` over text parsing — query all iframes for an accessible `<video>` element

---

## Issue 5 — Claim Reward poll times out if Discord is slow to unlock it

**Severity:** Low  
**Status:** Open

### Symptom
After the video wait, the extension polls for an unlocked Claim Reward button for up to `ELEMENT_TIMEOUT_MS` (15 seconds). On slow connections or if Discord's server hasn't registered the watch completion, the poll times out and the quest is skipped with: `Claim Reward never unlocked - skipping quest`.

### Root cause
Discord unlocks the Claim Reward button via a server-side event after confirming the watch percentage. The timing depends on network latency and Discord's backend processing speed.

### Workaround
Increase `ELEMENT_TIMEOUT_MS` in `content.js`:
```js
ELEMENT_TIMEOUT_MS: 30000,  // increase from 15s to 30s
```

### Fix direction
- Increase the default timeout to 30 seconds
- Add a specific error message distinguishing "button not found" from "button found but still locked"

---

## Issue 6 — Orb balance counter shows "—" in popup

**Severity:** Low (cosmetic)  
**Status:** Open

### Symptom
The **Orbs** stat in the popup always shows `—` instead of the current balance.

### Root cause
`scrapeOrbBalance()` queries Discord's DOM for elements with class names containing "currency", "balance", or "orb". Discord uses obfuscated/hashed class names that change with each deployment (e.g. `currency_abc123`). The substring match is fragile and frequently misses the actual counter element.

### Workaround
The balance is still logged to the DevTools console (`[Orb Collector] Orb balance: 400`) after each claim. Check the console for accurate values.

### Fix direction
- Parse the balance from the reward modal text ("Your Orbs balance is now 400") at claim time, which is more reliable than querying the top bar
- The `findText('balance is now')` path in `scrapeOrbBalance()` should catch this — investigate why it falls through

---

## Issue 7 — Extension runs on all discord.com pages, not just quest-home

**Severity:** Low  
**Status:** By design with self-redirect

### Symptom
The content script loads on every `discord.com/*` page (as declared in `manifest.json`). On non-quest pages it immediately redirects to `/quest-home` when Start is pressed, which may be unexpected.

### Root cause
The `content_scripts` matcher is `https://discord.com/*` so the script initialises everywhere. The `ensureQuestHome()` function only redirects when `main()` runs (on page load or when Start is pressed from the popup).

### Workaround
Only press Start when you're already on `discord.com`. The extension will not auto-redirect unless you click Start.

### Fix direction
- Scope the content script to `https://discord.com/quest-home` only, and use `chrome.scripting.executeScript` to inject it into other tabs when needed