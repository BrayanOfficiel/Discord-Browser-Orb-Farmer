# Contributing

## Priorities

The most impactful open problems right now, in order:

1. **Selector robustness** — Discord's class names are hashed; prefer text, roles and `aria-*` attributes
2. **Mobile-only detection** (Issue 2) — the current text heuristic can miss cards
3. **Safari testing** — report anything that behaves differently from Chrome

The captcha is solved by the user on purpose; PRs that automate solving it won't be merged.

## How to contribute

1. Fork the repo and create a branch: `git checkout -b fix/video-completion`
2. Make your changes in `extension/content.js` (or `popup.js` / `popup.html` for UI work)
3. Test in Chrome (`chrome://extensions` → Load unpacked) and, if you can, in Safari (`scripts/build-safari.sh --open`)
4. If fixing a known issue, update the relevant entry in `KNOWN_ISSUES.md`
5. Open a pull request with a clear description of what changed and how you tested it

## Testing checklist

Before opening a PR, verify:
- [ ] Extension loads without errors in `chrome://extensions` (and in Safari)
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