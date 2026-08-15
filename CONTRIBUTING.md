# Contributing

## Priorities

The most impactful open problems right now, in order:

1. **Fix video completion detection** (Issue 1) — switch from wall-clock sleep to polling `video.ended` or `video.currentTime >= video.duration * 0.98`
2. **Surface mobile-only quests** (Issue 2) — detect and log skipped cards
3. **Improve hCaptcha reliability** (Issue 3) — retry logic before manual fallback
4. **Fix Orb balance scraping** (Issue 6) — parse from reward modal text instead of class-name queries

## How to contribute

1. Fork the repo and create a branch: `git checkout -b fix/video-completion`
2. Make your changes in `extension/content.js` (or `popup.js` / `popup.html` for UI work)
3. Test by loading the extension unpacked in Chrome (`chrome://extensions` → Load unpacked)
4. If fixing a known issue, update the relevant entry in `KNOWN_ISSUES.md`
5. Open a pull request with a clear description of what changed and how you tested it

## Testing checklist

Before opening a PR, verify:
- [ ] Extension loads without errors in `chrome://extensions`
- [ ] No errors in DevTools console on `discord.com/quest-home` page load
- [ ] Start button triggers the scan and opens a quest modal
- [ ] Video wait completes and Claim Reward is clicked
- [ ] Popup stats update (Claimed count increments, phase dot changes colour)
- [ ] Stop button halts the loop

## Code style

- Plain ES2020 JavaScript — no build tools, no bundler, no TypeScript
- Keep all automation logic in `content.js`
- Keep all popup UI logic in `popup.js`
- Add a `log()` / `warn()` / `err()` call at each significant step
- Update `KNOWN_ISSUES.md` if your change resolves or introduces a known issue