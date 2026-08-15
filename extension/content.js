/**
 * Discord Orb Collector - content.js
 * ====================================
 * 10-step automation for video quests on discord.com/quest-home
 *
 *  1.  Navigate to /quest-home if not already there
 *  2.  Wait for Discord React shell to fully render
 *  3.  Scroll the Available Quests grid into view
 *  4.  Discover and queue all Watch-Xs video-quest buttons
 *  5.  Click the first Watch button - video modal opens
 *  6.  Parse video duration from timestamp and wait it out
 *  7.  Detect hCaptcha - click iframe checkbox; pause for manual solve if needed
 *  8.  Click Claim Reward once it unlocks
 *  9.  Dismiss the reward modal
 * 10.  Loop to next quest with jitter; rescan for lazy-loaded cards
 */

'use strict';

// ============================================================
// Configuration - edit these values to tune the automation
// ============================================================

const CONFIG = {
  // Fallback wait when video duration cannot be parsed from the timestamp
  VIDEO_FALLBACK_MS:       3 * 60 * 1000,

  // Extra grace period after the video timer expires before hunting Claim
  POST_VIDEO_GRACE_MS:     3000,

  // Max time to poll for any expected DOM element before giving up
  ELEMENT_TIMEOUT_MS:      15000,

  // Interval between each poll tick
  POLL_INTERVAL_MS:        500,

  // Max time to wait for hCaptcha to auto-clear before asking user to solve
  CAPTCHA_AUTO_TIMEOUT_MS: 30000,

  // Random delay between quests to look more human (ms)
  JITTER_MIN_MS:           2000,
  JITTER_MAX_MS:           4500,

  QUEST_HOME_URL: 'https://discord.com/quest-home',
};

// ============================================================
// State machine
// idle | navigating | scanning | watching | captcha | claiming | dismissing | done
// ============================================================

const STATE = {
  phase:      'boot',
  questQueue: [],   // Watch-button DOM nodes waiting to be processed
};

// ============================================================
// Logging  (coloured output in DevTools console)
// ============================================================

const log  = (m, ...a) => console.log(  '%c[Orb Collector]%c ' + m, 'color:#7289da;font-weight:bold', 'color:inherit', ...a);
const warn = (m, ...a) => console.warn( '%c[Orb Collector]%c ' + m, 'color:#faa61a;font-weight:bold', 'color:inherit', ...a);
const err  = (m, ...a) => console.error('%c[Orb Collector]%c ' + m, 'color:#ed4245;font-weight:bold', 'color:inherit', ...a);

// ============================================================
// Utilities
// ============================================================

const sleep   = ms => new Promise(r => setTimeout(r, ms));
const randInt = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;

/**
 * Full MouseEvent chain so React synthetic events fire reliably.
 * A bare .click() is sometimes swallowed by React's event delegation.
 */
function nativeClick(el) {
  ['mouseover', 'mouseenter', 'mousemove', 'mousedown', 'mouseup', 'click'].forEach(t =>
    el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))
  );
}

/** .click() with MouseEvent chain as fallback. */
function reliableClick(el) {
  try { el.click(); } catch (_) { nativeClick(el); }
}

/** True when the element is attached to layout with non-zero dimensions. */
function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/**
 * Polls fn() every POLL_INTERVAL_MS until it returns a truthy value
 * or ms elapses. Returns the truthy value or null on timeout.
 */
async function waitFor(fn, ms = CONFIG.ELEMENT_TIMEOUT_MS) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(CONFIG.POLL_INTERVAL_MS);
  }
  return null;
}

/** First visible button/[role=button] whose text matches the regex. */
function findButton(re) {
  const nodes = document.querySelectorAll(
    'button, [role="button"], [class*="button" i], [class*="btn" i]'
  );
  for (const el of nodes) {
    if (!isVisible(el)) continue;
    const t = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
    if (re.test(t)) return el;
  }
  return null;
}

/**
 * TreeWalker text search - faster than querySelectorAll('*') for scanning
 * large React-rendered DOM trees.
 */
function findText(str) {
  const lo = str.toLowerCase();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (n.textContent.toLowerCase().includes(lo)) return n.parentElement;
  }
  return null;
}

// ============================================================
// Step 1 - Ensure we are on quest-home
// ============================================================

function ensureQuestHome() {
  const path = window.location.pathname.replace(/\/$/, '');
  if (path !== '/quest-home') {
    log('Not on quest-home - redirecting...');
    STATE.phase = 'navigating';
    window.location.replace(CONFIG.QUEST_HOME_URL);
    return false;   // page reloads; content script re-runs automatically
  }
  log('On quest-home');
  return true;
}

// ============================================================
// Step 2 - Wait for React shell (#app-mount) to render
// ============================================================

async function waitForAppMount() {
  log('Waiting for app shell...');
  await waitFor(() => {
    const mount = document.getElementById('app-mount');
    if (!mount) return false;
    const child = mount.querySelector('[class]');
    return child && child.offsetHeight > 0;   // has real layout content
  }, 30000);
  log('App shell ready');
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
    log('Scrolled to Available Quests heading');
  } else {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    warn('Heading not found - scrolled to bottom as fallback');
  }
  await sleep(1000);   // wait for scroll + lazy render
}

// ============================================================
// Step 4 - Collect Watch-Xs buttons into the queue
// ============================================================

// Matches: "Watch 1m", "Watch 36s", "Watch 2m 30s", etc.
const WATCH_RE = /^watch\s+\d/i;

function collectWatchButtons() {
  const out = [];
  const nodes = document.querySelectorAll(
    'button, [role="button"], [class*="button" i], [class*="btn" i]'
  );
  for (const el of nodes) {
    if (!isVisible(el)) continue;
    const t = (el.innerText || el.textContent || '').trim();
    if (WATCH_RE.test(t)) {
      out.push(el);
      log('  Queued: ' + JSON.stringify(t));
    }
  }
  return out;
}

async function buildQueue() {
  log('Scanning for video quests...');
  const found = await waitFor(() => collectWatchButtons().length > 0, 10000);
  if (!found) {
    warn('No Watch-Xs buttons found - no video quests available or all already claimed');
    return;
  }
  STATE.questQueue = collectWatchButtons();
  log(STATE.questQueue.length + ' video quest(s) queued');
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

  if (!btn) { warn('No Watch button available'); return false; }

  const label = (btn.innerText || btn.textContent || '').trim();
  log('Clicking ' + JSON.stringify(label) + '...');
  reliableClick(btn);

  // Wait for the video modal to appear
  const opened = await waitFor(() =>
    document.querySelector('video') ||
    document.querySelector('[class*="videoModal" i]') ||
    document.querySelector('[class*="questModal" i]') ||
    findText('/ 0:'),    // timestamp like "0:01 / 0:37" appearing in modal
    8000
  );

  if (!opened) { warn('Video modal did not open'); return false; }
  log('Video modal open');
  return true;
}

// ============================================================
// Step 6 - Parse video duration and wait
// ============================================================

function parseDuration() {
  // Discord shows "0:01 / 0:37" - capture the total-duration half after the slash
  const m = document.body.innerText.match(/\/\s*(\d+):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const hasHours = !!m[3];
    const h  = hasHours ? parseInt(m[1], 10) : 0;
    const mi = hasHours ? parseInt(m[2], 10) : parseInt(m[1], 10);
    const s  = hasHours ? parseInt(m[3], 10) : parseInt(m[2], 10);
    const ms = ((h * 3600) + (mi * 60) + s) * 1000;
    log('Duration: ' + h + 'h ' + mi + 'm ' + s + 's (' + ms + 'ms)');
    return ms;
  }

  // Fallback: read directly from the <video> element
  const vid = document.querySelector('video');
  if (vid && isFinite(vid.duration) && vid.duration > 0) {
    const ms = Math.ceil(vid.duration * 1000);
    log('Duration from <video> element: ' + ms + 'ms');
    return ms;
  }

  warn('Duration unknown - using fallback ' + CONFIG.VIDEO_FALLBACK_MS + 'ms');
  return CONFIG.VIDEO_FALLBACK_MS;
}

async function waitForVideo(durationMs) {
  const total = durationMs + 2000;   // 2s buffer on top of actual duration
  log('Waiting ' + (total / 1000).toFixed(1) + 's for video to finish...');
  await sleep(total);
  await sleep(CONFIG.POST_VIDEO_GRACE_MS);   // extra React re-render grace
  log('Video wait complete');
}

// ============================================================
// Step 7 - hCaptcha handling
// ============================================================

function captchaUp() {
  return !!(
    findText('Are you human') ||
    findText('confirm you') ||
    document.querySelector('iframe[src*="hcaptcha.com"]') ||
    document.querySelector('[class*="captcha" i]')
  );
}

// In-page banner shown when manual solve is needed
let _banner = null;

function showBanner(msg) {
  if (_banner) return;
  _banner = Object.assign(document.createElement('div'), { textContent: msg });
  Object.assign(_banner.style, {
    position:    'fixed',
    top:         '14px',
    left:        '50%',
    transform:   'translateX(-50%)',
    zIndex:      '999999',
    background:  '#ed4245',
    color:       '#fff',
    padding:     '11px 22px',
    borderRadius:'8px',
    font:        'bold 13px/1 sans-serif',
    boxShadow:   '0 4px 14px rgba(0,0,0,.45)',
    pointerEvents:'none',
  });
  document.body.appendChild(_banner);
}

function hideBanner() {
  if (_banner) { _banner.remove(); _banner = null; }
}

async function handleCaptcha() {
  if (!captchaUp()) return;

  STATE.phase = 'captcha';
  log('hCaptcha detected - attempting auto-click...');
  await sleep(1500);   // let iframe load its checkbox

  const iframe = document.querySelector('iframe[src*="hcaptcha.com"]');
  if (iframe) {
    // hCaptcha renders its checkbox at the top-left of its cross-origin iframe.
    // Content scripts cannot reach inside cross-origin iframes directly, but
    // clicking the iframe element itself delivers the pointer event into it.
    const r = iframe.getBoundingClientRect();
    iframe.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, view: window,
      clientX: r.left + 20,
      clientY: r.top  + 20,
    }));
    log('Clicked hCaptcha iframe checkbox area');
  } else {
    // Discord sometimes renders the checkbox outside an iframe
    const b = findButton(/i am human/i);
    if (b) { reliableClick(b); log('Clicked I am human button'); }
    else   { warn('No captcha element found - waiting for manual solve'); }
  }

  const cleared = await waitFor(() => !captchaUp(), CONFIG.CAPTCHA_AUTO_TIMEOUT_MS);

  if (cleared) {
    log('Captcha cleared automatically');
  } else {
    // Escalated to image challenge - pause and let the user solve it
    showBanner('Orb Collector paused - please solve the captcha manually');
    warn('Waiting for manual captcha solve (up to 5 min)...');
    await waitFor(() => !captchaUp(), 5 * 60 * 1000);
    hideBanner();
    log('Manual captcha solved - resuming');
  }
}

// ============================================================
// Step 8 - Claim reward
// ============================================================

async function claimReward() {
  STATE.phase = 'claiming';
  log('Waiting for Claim Reward to unlock...');

  // The button is visible but aria-disabled + has a lock icon child while the
  // video is still playing. We poll until both conditions are gone.
  const CLAIM_RE = /claim\s*reward|^claim$/i;

  const btn = await waitFor(() => {
    const nodes = document.querySelectorAll(
      'button, [role="button"], [class*="button" i]'
    );
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const t = (el.innerText || el.textContent || '').trim();
      if (!CLAIM_RE.test(t)) continue;
      if (el.disabled) continue;
      if (el.getAttribute('aria-disabled') === 'true') continue;
      if (el.querySelector('[class*="lock" i]')) continue;
      return el;
    }
    return null;
  }, CONFIG.ELEMENT_TIMEOUT_MS);

  if (!btn) { err('Claim Reward never unlocked - skipping quest'); return false; }

  log('Clicking Claim Reward...', btn);
  reliableClick(btn);
  log('Claimed!');
  return true;
}

// ============================================================
// Step 9 - Dismiss reward modal
// ============================================================

async function dismissModal() {
  STATE.phase = 'dismissing';
  log('Waiting for reward modal...');

  const modal = await waitFor(() =>
    findText('Discord Orbs')   ||
    findText('balance is now') ||
    findText('Orbs balance')   ||
    document.querySelector('[class*="rewardModal" i]'),
    8000
  );

  if (modal) {
    // Log the new Orb balance for the user
    const info = findText('balance is now');
    if (info) {
      const p = info.closest('p, div, span');
      if (p) log('  ' + p.innerText.trim());
    }
    await sleep(1500);   // let the orb animation play
  } else {
    warn('Reward modal not detected - dismissing anyway');
  }

  // Prefer an explicit close button; fall back to Escape key
  const close =
    document.querySelector('[aria-label*="close" i]')   ||
    document.querySelector('[aria-label*="dismiss" i]') ||
    findButton(/^[x\u00d7\u2715]$/i);

  if (close && isVisible(close)) {
    reliableClick(close);
    log('Closed reward modal');
  } else {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true,
    }));
    log('Sent Escape to dismiss modal');
  }
  await sleep(800);
}

// ============================================================
// Step 10 - Main quest loop
// ============================================================

async function runLoop() {
  while (STATE.questQueue.length > 0) {
    STATE.phase = 'watching';
    log('--- Quest start (' + STATE.questQueue.length + ' remaining) ---');

    const opened = await openNextQuest();         // Step 5
    if (!opened) { warn('Skipping quest'); continue; }

    const dur = parseDuration();                  // Step 6
    await waitForVideo(dur);

    await handleCaptcha();                        // Step 7

    const claimed = await claimReward();          // Step 8
    if (claimed) await dismissModal();            // Step 9

    // Rescan for any quest cards that lazy-loaded during this iteration
    const fresh = collectWatchButtons().filter(b => !STATE.questQueue.includes(b));
    if (fresh.length) {
      log(fresh.length + ' new quest(s) discovered - appending to queue');
      STATE.questQueue.push(...fresh);
    }

    // Human-pace jitter before the next quest
    if (STATE.questQueue.length > 0) {
      const jitter = randInt(CONFIG.JITTER_MIN_MS, CONFIG.JITTER_MAX_MS);
      log('Jitter ' + jitter + 'ms...');
      await sleep(jitter);
    }
  }

  STATE.phase = 'done';
  log('=== All video quests complete! ===');
}

// ============================================================
// Boot
// ============================================================

async function main() {
  log('Discord Orb Collector starting...');

  if (!ensureQuestHome()) return;        // Step 1 (redirects if needed)
  await waitForAppMount();               // Step 2
  await sleep(2000);                     // extra hydration time for quest cards
  await scrollToGrid();                  // Step 3
  await buildQueue();                    // Step 4

  if (STATE.questQueue.length === 0) {
    log('No quests to run - done');
    return;
  }

  await runLoop();                       // Steps 5-10
}

main().catch(e => err('Fatal error:', e));

// ============================================================
// UI Bridge - extra STATE fields + popup message handler
// ============================================================

// Extend STATE with fields the popup needs
STATE.questsDone   = 0;     // how many quests have been claimed this session
STATE.orbBalance   = null;  // last known orb balance parsed from reward modal
STATE.currentQuest = null;  // label of the quest currently being watched
STATE.videoStart   = null;  // epoch ms when the current video wait began
STATE.videoDurMs   = 0;     // duration of the current video in ms
STATE.stopped      = false; // user pressed Stop

/**
 * Pushes a snapshot of STATE to the popup (if it is open).
 * Safe to call at any time - fails silently if popup is closed.
 */
function pushToPopup(logText, logLevel) {
  const payload = {
    type:  'orbCollectorEvent',
    state: getStatusSnapshot(),
  };
  if (logText) payload.log = { text: logText, level: logLevel || 'info' };
  try { chrome.runtime.sendMessage(payload); } catch (_) { /* popup closed */ }
}

/** Returns a plain-object snapshot of the current STATE for the popup. */
function getStatusSnapshot() {
  let videoProgress = 0;
  if (STATE.phase === 'watching' && STATE.videoStart && STATE.videoDurMs > 0) {
    const elapsed = Date.now() - STATE.videoStart;
    videoProgress = Math.min(100, Math.round((elapsed / STATE.videoDurMs) * 100));
  }
  return {
    phase:         STATE.phase,
    questsDone:    STATE.questsDone,
    questQueue:    STATE.questQueue.length,
    orbBalance:    STATE.orbBalance,
    currentQuest:  STATE.currentQuest,
    videoProgress: videoProgress,
  };
}

/**
 * Reads the current Orbs balance from the top-right counter in the Discord UI.
 * Discord renders it as text near the orb icon - e.g. "200" or "1,200".
 */
function scrapeOrbBalance() {
  // The balance counter sits near "[orb icon] NNN" in the top bar
  const candidates = document.querySelectorAll('[class*="currency" i], [class*="balance" i], [class*="orb" i]');
  for (const el of candidates) {
    const t = (el.innerText || el.textContent || '').trim().replace(/,/g, '');
    if (/^\d+$/.test(t) && parseInt(t, 10) > 0) {
      return parseInt(t, 10);
    }
  }
  // Fallback: look for "Your Orbs balance is now NNN" text
  const info = findText('balance is now');
  if (info) {
    const m = (info.innerText || '').match(/(\d[\d,]*)\s*$/);
    if (m) return parseInt(m[1].replace(/,/g, ''), 10);
  }
  return null;
}

// Patch the existing functions to push state updates to the popup
// We wrap them after definition so we don't break the original logic.

const _origBuildQueue = buildQueue;
buildQueue = async function() {
  STATE.phase = 'scanning';
  pushToPopup('Scanning for video quests…', 'info');
  await _origBuildQueue();
  pushToPopup(STATE.questQueue.length + ' quest(s) found', 'good');
};

const _origOpenNextQuest = openNextQuest;
openNextQuest = async function() {
  const result = await _origOpenNextQuest();
  if (result) {
    // try to grab the quest name from the modal title area
    const titleEl = document.querySelector('[class*="questTitle" i], [class*="quest-title" i]') ||
                    findText('Quest') || null;
    STATE.currentQuest = titleEl
      ? (titleEl.innerText || '').trim().split('\n')[0].slice(0, 40)
      : null;
    pushToPopup('Opened quest: ' + (STATE.currentQuest || '(unknown)'), 'info');
  }
  return result;
};

const _origWaitForVideo = waitForVideo;
waitForVideo = async function(durationMs) {
  STATE.videoStart  = Date.now();
  STATE.videoDurMs  = durationMs;
  pushToPopup('Video started (' + (durationMs / 1000).toFixed(0) + 's)', 'info');

  // Tick the progress bar every 3s while waiting
  const tickInterval = setInterval(() => {
    if (STATE.phase === 'watching') pushToPopup(null);
  }, 3000);

  await _origWaitForVideo(durationMs);
  clearInterval(tickInterval);
  STATE.videoStart = null;
  pushToPopup('Video complete', 'info');
};

const _origHandleCaptcha = handleCaptcha;
handleCaptcha = async function() {
  const before = STATE.phase;
  await _origHandleCaptcha();
  if (STATE.phase === 'captcha') {
    pushToPopup('Captcha detected - waiting…', 'warn');
  }
};

const _origClaimReward = claimReward;
claimReward = async function() {
  const result = await _origClaimReward();
  if (result) {
    STATE.questsDone++;
    const bal = scrapeOrbBalance();
    if (bal !== null) STATE.orbBalance = bal;
    pushToPopup('Reward claimed! Total: ' + STATE.questsDone, 'good');
  }
  return result;
};

const _origDismissModal = dismissModal;
dismissModal = async function() {
  await _origDismissModal();
  const bal = scrapeOrbBalance();
  if (bal !== null) {
    STATE.orbBalance = bal;
    pushToPopup('Orb balance: ' + bal, 'good');
  }
  STATE.currentQuest = null;
  pushToPopup(null);  // refresh stats
};

// ── Message listener (popup → content script) ────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'getStatus') {
    sendResponse(getStatusSnapshot());
    return true;
  }

  if (msg.action === 'start') {
    if (['idle', 'done', 'stopped', 'boot'].includes(STATE.phase)) {
      STATE.stopped    = false;
      STATE.questsDone = 0;
      STATE.phase      = 'scanning';
      // Re-run from Step 3 onwards (we're already on quest-home if popup is open)
      (async () => {
        try {
          await scrollToGrid();
          await buildQueue();
          if (STATE.questQueue.length > 0) {
            await runLoop();
          } else {
            STATE.phase = 'idle';
            pushToPopup('No quests found', 'warn');
          }
        } catch(e) {
          STATE.phase = 'error';
          pushToPopup('Error: ' + e.message, 'error');
          err('Error in start handler:', e);
        }
      })();
    }
    sendResponse(getStatusSnapshot());
    return true;
  }

  if (msg.action === 'stop') {
    STATE.stopped = true;
    STATE.phase   = 'stopped';
    hideBanner();
    pushToPopup('Stopped by user', 'warn');
    sendResponse(getStatusSnapshot());
    return true;
  }
});

// Push an initial heartbeat so the popup gets state immediately on open
pushToPopup('Content script ready', 'good');