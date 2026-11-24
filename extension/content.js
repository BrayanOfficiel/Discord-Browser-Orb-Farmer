/**
 * Discord Orb Collector - content.js
 * ====================================
 * Automation for video quests on discord.com/quest-home.
 * Works in Chrome / Chromium (MV3) and Safari (Safari Web Extension).
 *
 * Nothing runs until the user presses Start in the popup.
 *
 *  1.  Navigate to /quest-home if not already there (resumes after reload)
 *  2.  Wait for Discord React shell to fully render
 *  3.  Scroll the Available Quests grid into view
 *  4.  Discover and queue all Watch-Xs video-quest buttons
 *  5.  Click the next Watch button - video modal opens
 *  6.  Follow the real <video> element until it has actually finished
 *  7.  If an hCaptcha checkpoint appears, pause until the user solves it
 *  8.  Click Claim Reward once it unlocks
 *  9.  Dismiss the reward modal and read the new Orb balance
 * 10.  Loop to the next quest; rescan for lazy-loaded cards
 */

'use strict';

// Chrome exposes `chrome.*`, Safari exposes both `browser.*` and `chrome.*`.
const api = globalThis.browser ?? globalThis.chrome;

// ============================================================
// Configuration - edit these values to tune the automation
// ============================================================

const CONFIG = {
  // Wait used only when neither a <video> element nor a "0:01 / 0:37"
  // timestamp can be found in the quest modal
  VIDEO_FALLBACK_MS:       3 * 60 * 1000,

  // How long to keep retrying to locate the <video> / timestamp after the modal opens
  VIDEO_DETECT_TIMEOUT_MS: 8000,

  // A video counts as finished once currentTime reaches this fraction of duration
  VIDEO_DONE_RATIO:        0.98,

  // Extra grace period after the video ends before hunting Claim
  POST_VIDEO_GRACE_MS:     3000,

  // Max time to poll for any expected DOM element before giving up
  ELEMENT_TIMEOUT_MS:      15000,

  // Max time to wait for Claim Reward to unlock after the video
  CLAIM_TIMEOUT_MS:        30000,

  // Interval between each poll tick
  POLL_INTERVAL_MS:        500,

  // Max time to wait for the user to solve a captcha
  CAPTCHA_MANUAL_TIMEOUT_MS: 5 * 60 * 1000,

  // Random pause between quests (ms)
  JITTER_MIN_MS:           2000,
  JITTER_MAX_MS:           4500,

  // A quest whose Watch button is still there after this many attempts is skipped
  MAX_ATTEMPTS_PER_QUEST:  2,

  QUEST_HOME_URL: 'https://discord.com/quest-home',
  PENDING_START_KEY: 'orbCollectorPendingStart',
};

// ============================================================
// State
// boot | idle | navigating | scanning | watching | captcha |
// claiming | dismissing | done | stopped | error
// ============================================================

const STATE = {
  phase:        'idle',
  running:      false,
  stopped:      false,
  questQueue:   [],          // Watch-button DOM nodes waiting to be processed
  attempts:     new Map(),   // quest key -> number of attempts this run
  questsDone:   0,
  skipped:      0,
  orbBalance:   null,
  currentQuest: null,
  videoProgress: 0,          // 0-100
};

class StoppedError extends Error {
  constructor() { super('Stopped by user'); this.name = 'StoppedError'; }
}

// ============================================================
// Logging (console + popup)
// ============================================================

const PREFIX = '%c[Orb Collector]%c ';
const log  = (m, ...a) => { console.log(  PREFIX + m, 'color:#7289da;font-weight:bold', 'color:inherit', ...a); };
const warn = (m, ...a) => { console.warn( PREFIX + m, 'color:#faa61a;font-weight:bold', 'color:inherit', ...a); };
const err  = (m, ...a) => { console.error(PREFIX + m, 'color:#ed4245;font-weight:bold', 'color:inherit', ...a); };

function snapshot() {
  return {
    phase:         STATE.phase,
    questsDone:    STATE.questsDone,
    questQueue:    STATE.questQueue.length,
    skipped:       STATE.skipped,
    orbBalance:    STATE.orbBalance,
    currentQuest:  STATE.currentQuest,
    videoProgress: STATE.videoProgress,
  };
}

/** Pushes state (and optionally a log line) to the popup if it is open. */
function push(text, level) {
  const payload = { type: 'orbCollectorEvent', state: snapshot() };
  if (text) payload.log = { text, level: level || 'info' };
  try {
    const p = api.runtime.sendMessage(payload);
    // No listener (popup closed) rejects the promise - that's expected
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) { /* extension reloaded / context invalidated */ }
}

/** Console + popup log in one call. */
function report(text, level = 'info') {
  (level === 'error' ? err : level === 'warn' ? warn : log)(text);
  push(text, level);
}

function setPhase(phase) {
  STATE.phase = phase;
  push(null);
}

// ============================================================
// Utilities
// ============================================================

const randInt = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;

function checkStop() {
  if (STATE.stopped) throw new StoppedError();
}

/** Sleep that wakes up early (and throws) when the user presses Stop. */
async function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    checkStop();
    await new Promise(r => setTimeout(r, Math.min(250, end - Date.now())));
  }
  checkStop();
}

/**
 * Polls fn() every POLL_INTERVAL_MS until it returns a truthy value
 * or ms elapses. Returns the truthy value or null on timeout.
 */
async function waitFor(fn, ms = CONFIG.ELEMENT_TIMEOUT_MS) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    checkStop();
    const v = fn();
    if (v) return v;
    await sleep(CONFIG.POLL_INTERVAL_MS);
  }
  return null;
}

/** Full MouseEvent chain so React's delegated handlers fire reliably. */
function reliableClick(el) {
  el.scrollIntoView({ block: 'center' });
  for (const t of ['pointerover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    const Ctor = t.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(t, { bubbles: true, cancelable: true, view: window }));
  }
  el.click();
}

/** True when the element is attached to layout with non-zero dimensions. */
function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function textOf(el) {
  return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
}

const CLICKABLE = 'button, [role="button"], a[href], [class*="button" i]';

/**
 * Returns visible clickable elements whose text matches `re`, normalised to the
 * real button (Discord nests [class*=button] divs inside <button>s, which used
 * to queue the same quest twice).
 */
function findButtons(re, root = document) {
  const seen = new Set();
  const out = [];
  for (const el of root.querySelectorAll(CLICKABLE)) {
    if (!isVisible(el)) continue;
    const t = textOf(el) || el.getAttribute('aria-label') || '';
    if (!re.test(t)) continue;
    const btn = el.closest('button, [role="button"]') || el;
    if (seen.has(btn)) continue;
    seen.add(btn);
    out.push(btn);
  }
  return out;
}

const findButton = (re, root) => findButtons(re, root)[0] || null;

/** Walks visible text nodes only (skips <script>/<style> and hidden elements). */
function textWalker(root = document.body) {
  return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || p.closest('script, style, noscript, template')) return NodeFilter.FILTER_REJECT;
      return isVisible(p) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
}

/** Returns the parent element of the first visible text node containing str. */
function findText(str, root = document.body) {
  const lo = str.toLowerCase();
  const walker = textWalker(root);
  let n;
  while ((n = walker.nextNode())) {
    if (n.textContent.toLowerCase().includes(lo)) return n.parentElement;
  }
  return null;
}

/** The top-most open modal, or document.body if none. */
function topDialog() {
  const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(isVisible);
  return dialogs[dialogs.length - 1] || null;
}

function isOnQuestHome() {
  return window.location.pathname.replace(/\/$/, '') === '/quest-home';
}

// ============================================================
// Pending-start flag (survives the redirect to quest-home)
// ============================================================

async function setPendingStart(value) {
  try {
    if (value) await api.storage.local.set({ [CONFIG.PENDING_START_KEY]: Date.now() });
    else       await api.storage.local.remove(CONFIG.PENDING_START_KEY);
  } catch (e) { warn('storage unavailable: ' + e.message); }
}

async function consumePendingStart() {
  try {
    const got = await api.storage.local.get(CONFIG.PENDING_START_KEY);
    const ts  = got && got[CONFIG.PENDING_START_KEY];
    if (ts) await api.storage.local.remove(CONFIG.PENDING_START_KEY);
    // Only honour a recent request (avoids surprise starts days later)
    return !!ts && Date.now() - ts < 2 * 60 * 1000;
  } catch (_) {
    return false;
  }
}

// ============================================================
// Step 1/2 - Navigate and wait for the React shell
// ============================================================

async function waitForAppMount() {
  log('Waiting for app shell...');
  const ok = await waitFor(() => {
    const mount = document.getElementById('app-mount');
    const child = mount && mount.querySelector('[class]');
    return child && child.offsetHeight > 0;
  }, 30000);
  if (!ok) warn('App shell not detected after 30s - continuing anyway');
  await sleep(2000);   // extra hydration time for quest cards
}

// ============================================================
// Step 3 - Scroll the quest grid into view
// ============================================================

async function scrollToGrid() {
  log('Scrolling to quest grid...');
  await sleep(1200);   // let hero banner settle

  const heading = findText('Available Quests');
  if (heading) {
    heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    // Discord's quest page scrolls inside its own container, not the window
    const scroller = [...document.querySelectorAll('[class*="scroller" i]')]
      .filter(el => el.scrollHeight > el.clientHeight)
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    else window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    warn('"Available Quests" heading not found - scrolled to bottom as fallback');
  }
  await sleep(1000);   // wait for scroll + lazy render
}

// ============================================================
// Step 4 - Collect Watch-Xs buttons into the queue
// ============================================================

// Matches: "Watch 1m", "Watch 36s", "Watch 2m 30s", "Watch Video", etc.
const WATCH_RE = /^watch(\s+\d|\s+video\b)/i;

/** A stable-ish key for a quest card, so retries survive React re-renders. */
function questKey(btn) {
  let card = btn;
  for (let i = 0; i < 6 && card.parentElement; i++) {
    card = card.parentElement;
    if (textOf(card).length > 40) break;
  }
  return textOf(card).slice(0, 120);
}

function collectWatchButtons() {
  return findButtons(WATCH_RE).filter(btn => {
    if (topDialog() && topDialog().contains(btn)) return false;   // ignore modal contents
    const tries = STATE.attempts.get(questKey(btn)) || 0;
    return tries < CONFIG.MAX_ATTEMPTS_PER_QUEST;
  });
}

/**
 * Issue 2: video quests gated to the mobile client show their "watch the video"
 * description but no Watch button in the browser. Log them so the user knows.
 */
function reportMobileOnlyQuests() {
  const seen = new Set();
  const walker = textWalker();
  let n;
  while ((n = walker.nextNode())) {
    if (!/watch the video/i.test(n.textContent)) continue;
    let card = n.parentElement;
    // climb to the first ancestor that contains at least one button (the card)
    for (let i = 0; i < 8 && card && !card.querySelector('button'); i++) card = card.parentElement;
    if (!card || seen.has(card)) continue;
    seen.add(card);
    if (findButtons(WATCH_RE, card).length === 0 && !/claimed|completed/i.test(textOf(card))) {
      const title = textOf(card).slice(0, 60);
      report('Skipped (mobile-only?): ' + title, 'warn');
    }
  }
}

async function buildQueue() {
  setPhase('scanning');
  report('Scanning for video quests...');
  await waitFor(() => collectWatchButtons().length > 0, 10000);
  STATE.questQueue = collectWatchButtons();
  reportMobileOnlyQuests();
  report(STATE.questQueue.length + ' video quest(s) queued', STATE.questQueue.length ? 'good' : 'warn');
}

// ============================================================
// Step 5 - Click Watch button and wait for video modal
// ============================================================

async function openNextQuest() {
  let btn = STATE.questQueue.shift();

  // Button reference can go stale after React re-renders
  if (!btn || !isVisible(btn)) {
    log('Queued button stale - rescanning...');
    STATE.questQueue = collectWatchButtons();
    btn = STATE.questQueue.shift();
  }
  if (!btn) return false;

  const key = questKey(btn);
  STATE.attempts.set(key, (STATE.attempts.get(key) || 0) + 1);

  log('Clicking ' + JSON.stringify(textOf(btn)) + '...');
  reliableClick(btn);

  const opened = await waitFor(() =>
    document.querySelector('video') ||
    (topDialog() && findText('/ 0:', topDialog())) ||
    topDialog(),
    8000
  );
  if (!opened) { report('Video modal did not open', 'warn'); return false; }

  const dlg = topDialog();
  const heading = dlg && dlg.querySelector('h1, h2, h3, [class*="title" i]');
  STATE.currentQuest = heading ? textOf(heading).slice(0, 60) : textOf(btn);
  report('Opened quest: ' + STATE.currentQuest);
  return true;
}

// ============================================================
// Step 6 - Follow the real video until it has finished
// ============================================================

/** Parses "0:01 / 0:37" (or "0:01 / 1:02:03") from the modal. Returns ms or null. */
function parseTimestampMs() {
  const root = topDialog() || document.body;
  const m = (root.innerText || '').match(/\d+:\d{2}(?::\d{2})?\s*\/\s*(\d+):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const hasHours = m[3] !== undefined;
  const h  = hasHours ? +m[1] : 0;
  const mi = hasHours ? +m[2] : +m[1];
  const s  = hasHours ? +m[3] : +m[2];
  const ms = (h * 3600 + mi * 60 + s) * 1000;
  return ms > 0 ? ms : null;
}

function findVideo() {
  const dlg = topDialog();
  const vids = [...(dlg || document).querySelectorAll('video')];
  return vids.find(v => isFinite(v.duration) && v.duration > 0) || vids[0] || null;
}

/** Starts playback if the browser's autoplay policy blocked it (Safari does). */
async function ensurePlaying(video) {
  if (!video.paused || video.ended) return;
  try {
    await video.play();
  } catch (_) {
    // Autoplay with sound is blocked without a real user gesture - muted is allowed
    video.muted = true;
    try { await video.play(); log('Autoplay blocked - playing muted'); }
    catch (e) { warn('Could not start video: ' + e.message); }
  }
}

async function watchVideo() {
  setPhase('watching');
  STATE.videoProgress = 0;

  // Retry for a few seconds - the player and its timestamp render after the modal
  const found = await waitFor(() => {
    const v = findVideo();
    if (v && isFinite(v.duration) && v.duration > 0) return { video: v };
    const ms = parseTimestampMs();
    if (ms) return { ms };
    return null;
  }, CONFIG.VIDEO_DETECT_TIMEOUT_MS);

  const video = (found && found.video) || findVideo();

  if (video) {
    await ensurePlaying(video);
    const durMs = isFinite(video.duration) && video.duration > 0
      ? video.duration * 1000
      : (found && found.ms) || CONFIG.VIDEO_FALLBACK_MS;
    report('Video started (' + Math.round(durMs / 1000) + 's)');

    // Hard ceiling so a frozen player can't hang the loop forever
    const deadline = Date.now() + durMs * 2 + 60000;
    let hiddenWarned = false;
    let lastTime = -1, stalledTicks = 0;

    while (Date.now() < deadline) {
      checkStop();
      const v = video.isConnected ? video : findVideo();
      if (!v) { warn('Video element disappeared'); break; }

      const d = isFinite(v.duration) && v.duration > 0 ? v.duration : durMs / 1000;
      STATE.videoProgress = Math.min(100, Math.round((v.currentTime / d) * 100));
      push(null);

      if (v.ended || v.currentTime >= d * CONFIG.VIDEO_DONE_RATIO) break;

      if (document.hidden && !hiddenWarned) {
        hiddenWarned = true;
        report('Discord tab is in the background - keep it visible or the video pauses', 'warn');
      }

      // Restart playback if it paused or stalled (focus loss, buffering)
      if (v.paused || v.currentTime === lastTime) stalledTicks++;
      else stalledTicks = 0;
      if (stalledTicks >= 4) { await ensurePlaying(v); stalledTicks = 0; }
      lastTime = v.currentTime;

      await sleep(1000);
    }
  } else {
    const ms = (found && found.ms) || CONFIG.VIDEO_FALLBACK_MS;
    if (!found) warn('No <video> or timestamp found - waiting fallback ' + Math.round(ms / 1000) + 's');
    else report('Video started (' + Math.round(ms / 1000) + 's, timer only)');
    const start = Date.now();
    while (Date.now() - start < ms + 2000) {
      STATE.videoProgress = Math.min(100, Math.round(((Date.now() - start) / ms) * 100));
      push(null);
      await sleep(1000);
    }
  }

  STATE.videoProgress = 100;
  report('Video complete');
  await sleep(CONFIG.POST_VIDEO_GRACE_MS);
}

// ============================================================
// Step 7 - Captcha checkpoint: pause for the user
// ============================================================

function captchaUp() {
  return !!(
    document.querySelector('iframe[src*="hcaptcha.com"], iframe[src*="captcha" i]') ||
    findText('Are you human') ||
    findText('confirm you are human')
  );
}

let _banner = null;

function showBanner(msg) {
  if (_banner) return;
  _banner = Object.assign(document.createElement('div'), { textContent: msg });
  Object.assign(_banner.style, {
    position: 'fixed', top: '14px', left: '50%', transform: 'translateX(-50%)',
    zIndex: '2147483647', background: '#ed4245', color: '#fff',
    padding: '11px 22px', borderRadius: '8px', font: 'bold 13px/1 sans-serif',
    boxShadow: '0 4px 14px rgba(0,0,0,.45)', pointerEvents: 'none',
  });
  document.body.appendChild(_banner);
}

function hideBanner() {
  if (_banner) { _banner.remove(); _banner = null; }
}

/**
 * The captcha is Discord's own anti-automation checkpoint; this extension does
 * not try to click or solve it. It pauses and waits for the user to do it.
 */
async function handleCaptcha() {
  if (!captchaUp()) return;
  const prev = STATE.phase;
  setPhase('captcha');
  showBanner('Orb Collector paused - please solve the captcha');
  report('Captcha shown - solve it in the Discord tab to continue', 'warn');
  try {
    const cleared = await waitFor(() => !captchaUp(), CONFIG.CAPTCHA_MANUAL_TIMEOUT_MS);
    if (!cleared) throw new Error('Captcha was not solved within 5 minutes');
    report('Captcha solved - resuming', 'good');
  } finally {
    hideBanner();
  }
  STATE.phase = prev;
}

// ============================================================
// Step 8 - Claim reward
// ============================================================

const CLAIM_RE = /^(claim(\s+reward)?|claim\s+\d[\d,]*\s+orbs?)$/i;

function isLocked(el) {
  return el.disabled ||
         el.getAttribute('aria-disabled') === 'true' ||
         !!el.querySelector('[class*="lock" i]');
}

async function claimReward() {
  setPhase('claiming');
  log('Waiting for Claim Reward to unlock...');

  let sawLocked = false;
  const btn = await waitFor(() => {
    // The captcha can show up late, right before the button unlocks
    if (captchaUp()) return null;
    for (const el of findButtons(CLAIM_RE)) {
      if (isLocked(el)) { sawLocked = true; continue; }
      return el;
    }
    return null;
  }, CONFIG.CLAIM_TIMEOUT_MS);

  if (!btn) {
    if (captchaUp()) { await handleCaptcha(); return claimReward(); }
    report(sawLocked
      ? 'Claim Reward stayed locked - Discord did not register the watch, skipping'
      : 'Claim Reward button not found - skipping', 'error');
    return false;
  }

  reliableClick(btn);
  STATE.questsDone++;
  report('Reward claimed! Total: ' + STATE.questsDone, 'good');
  return true;
}

// ============================================================
// Step 9 - Dismiss reward modal, read Orb balance
// ============================================================

function parseNumber(s) {
  const n = parseInt(String(s).replace(/[\s,.  ]/g, ''), 10);
  return isFinite(n) ? n : null;
}

/** Issue 6: read "Your Orbs balance is now 400." from the reward modal. */
function balanceFromModal() {
  const el = findText('balance is now');
  if (!el) return null;
  const block = el.closest('p, div, span') || el;
  const m = textOf(block).match(/balance is now\s*:?\s*([\d][\d,.\s  ]*)/i);
  return m ? parseNumber(m[1]) : null;
}

/** Fallback: the numeric counter next to the orb icon in Discord's header. */
function balanceFromHeader() {
  for (const el of document.querySelectorAll('[class*="orb" i], [class*="currency" i], [class*="balance" i]')) {
    if (!isVisible(el) || el.children.length > 3) continue;
    const t = textOf(el);
    if (/^\d[\d,.\s]*$/.test(t)) {
      const n = parseNumber(t);
      if (n !== null) return n;
    }
  }
  return null;
}

async function dismissModal() {
  setPhase('dismissing');

  const modal = await waitFor(() =>
    findText('balance is now') || findText('Orbs balance') || findText('Discord Orbs'),
    8000
  );

  const bal = balanceFromModal() ?? balanceFromHeader();
  if (bal !== null) {
    STATE.orbBalance = bal;
    report('Orb balance: ' + bal, 'good');
  }
  if (modal) await sleep(1500);   // let the orb animation play
  else warn('Reward modal not detected - dismissing anyway');

  const dlg = topDialog();
  const close =
    (dlg && dlg.querySelector('[aria-label*="close" i], [aria-label*="dismiss" i]')) ||
    findButton(/^([x×✕]|close|done|nice|got it|ok)$/i, dlg || document);

  if (close && isVisible(close)) {
    reliableClick(close);
  } else {
    const opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
  }
  await sleep(800);
  STATE.currentQuest = null;
  STATE.videoProgress = 0;
  push(null);
}

/** Closes the video modal when a quest is skipped so the next one can open. */
async function closeAnyModal() {
  const dlg = topDialog();
  if (!dlg) return;
  const close = dlg.querySelector('[aria-label*="close" i]');
  if (close) reliableClick(close);
  else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  await sleep(800);
}

// ============================================================
// Step 10 - Main quest loop
// ============================================================

async function runLoop() {
  while (true) {
    checkStop();
    if (STATE.questQueue.length === 0) {
      // Rescan for cards that lazy-loaded during the previous iteration
      STATE.questQueue = collectWatchButtons();
      if (STATE.questQueue.length === 0) break;
      report(STATE.questQueue.length + ' more quest(s) found');
    }

    log('--- Quest start (' + STATE.questQueue.length + ' in queue) ---');

    if (!(await openNextQuest())) { STATE.skipped++; continue; }

    await watchVideo();
    await handleCaptcha();

    if (await claimReward()) await dismissModal();
    else { STATE.skipped++; await closeAnyModal(); }

    const jitter = randInt(CONFIG.JITTER_MIN_MS, CONFIG.JITTER_MAX_MS);
    log('Pause ' + jitter + 'ms...');
    await sleep(jitter);
  }
}

async function run() {
  if (STATE.running) return;
  STATE.running   = true;
  STATE.stopped   = false;
  STATE.questsDone = 0;
  STATE.skipped   = 0;
  STATE.attempts  = new Map();
  STATE.questQueue = [];
  STATE.phase     = 'scanning';   // so the popup shows "running" right away

  try {
    await waitForAppMount();
    await scrollToGrid();
    await buildQueue();
    await runLoop();
    STATE.phase = 'done';
    report('All available video quests processed (' + STATE.questsDone + ' claimed, ' +
           STATE.skipped + ' skipped)', 'good');
  } catch (e) {
    if (e instanceof StoppedError) {
      STATE.phase = 'stopped';
      report('Stopped by user', 'warn');
    } else {
      STATE.phase = 'error';
      report('Error: ' + e.message, 'error');
      err(e);
    }
  } finally {
    STATE.running = false;
    STATE.currentQuest = null;
    STATE.videoProgress = 0;
    hideBanner();
    push(null);
  }
}

/** Start requested from the popup. Navigates first if needed. */
async function start() {
  if (STATE.running) return;
  if (!isOnQuestHome()) {
    STATE.phase = 'navigating';
    push('Navigating to quest-home...', 'info');
    await setPendingStart(true);
    window.location.assign(CONFIG.QUEST_HOME_URL);
    return;   // page reloads; boot() resumes the run
  }
  run();
}

function stop() {
  if (!STATE.running && STATE.phase !== 'navigating') return;
  STATE.stopped = true;
  STATE.phase = 'stopped';
  setPendingStart(false);
  hideBanner();
  push(null);
}

// ============================================================
// Popup bridge
// ============================================================

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.action !== 'string') return false;
  switch (msg.action) {
    case 'getStatus': break;
    case 'start':     start(); break;
    case 'stop':      stop();  break;
    default:          return false;
  }
  sendResponse(snapshot());
  return false;   // response sent synchronously
});

// ============================================================
// Boot - only resumes a run the user explicitly started
// ============================================================

(async function boot() {
  // Discord is a SPA: the content script only loads once, so a pending start
  // is consumed on the first load of /quest-home after the redirect.
  if (isOnQuestHome() && await consumePendingStart()) {
    log('Resuming run started from the popup');
    run();
  } else {
    push(null);
  }
})();
