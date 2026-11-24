'use strict';

// Chrome exposes `chrome.*`, Safari exposes both `browser.*` and `chrome.*`.
const api = globalThis.browser ?? globalThis.chrome;

const QUEST_HOME_URL = 'https://discord.com/quest-home';
const DISCORD_RE = /^https:\/\/discord\.com\//;

// ── Helpers ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function timestamp() {
  return new Date().toTimeString().slice(0, 8);
}

/** Adds a log line. Uses textContent only: messages contain Discord page text. */
function addLog(msg, type = 'info') {
  const ul = $('log-list');
  const li = document.createElement('li');
  li.className = type;
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = timestamp();
  const m = document.createElement('span');
  m.className = 'msg';
  m.textContent = String(msg);
  li.append(ts, m);
  ul.appendChild(li);
  while (ul.children.length > 40) ul.removeChild(ul.firstChild);
  ul.scrollTop = ul.scrollHeight;
}

// ── State reflected in the popup ─────────────────────────────────────────────

const ui = {
  phase:         'idle',
  questsDone:    0,
  questQueue:    0,
  orbBalance:    null,
  currentQuest:  null,
  videoProgress: 0,
};

const PHASE_META = {
  boot:       { dot: 'idle',    text: 'Ready' },
  idle:       { dot: 'idle',    text: 'Idle — ready to run' },
  navigating: { dot: 'running', text: 'Navigating to quest-home…' },
  scanning:   { dot: 'running', text: 'Scanning for quests…' },
  watching:   { dot: 'running', text: 'Watching video…' },
  captcha:    { dot: 'captcha', text: 'Solve the captcha in the Discord tab' },
  claiming:   { dot: 'running', text: 'Claiming reward…' },
  dismissing: { dot: 'running', text: 'Dismissing modal…' },
  done:       { dot: 'done',    text: 'All quests processed 🎉' },
  stopped:    { dot: 'idle',    text: 'Stopped by user' },
  error:      { dot: 'error',   text: 'Error — check the log' },
  no_tab:     { dot: 'error',   text: 'No Discord tab found' },
  no_script:  { dot: 'error',   text: 'Extension not active on this tab' },
};

const RUNNING = ['navigating', 'scanning', 'watching', 'captcha', 'claiming', 'dismissing'];

function applyState(s) {
  for (const k of Object.keys(ui)) if (s[k] !== undefined) ui[k] = s[k];

  const meta = PHASE_META[ui.phase] || PHASE_META.idle;
  $('dot').className = 'dot ' + meta.dot;
  $('status-text').textContent = meta.text;

  $('stat-done').textContent  = ui.questsDone;
  $('stat-queue').textContent = ui.questQueue;
  $('stat-orbs').textContent  = ui.orbBalance !== null ? ui.orbBalance : '—';

  const pct = ui.phase === 'watching' ? ui.videoProgress : 0;
  $('progress-fill').style.width  = pct + '%';
  $('progress-pct').textContent   = pct > 0 ? pct + '%' : '';
  $('progress-label').textContent = ui.phase === 'watching' ? 'Watching…' : 'No active quest';

  const cq = $('current-quest');
  cq.textContent = '';
  if (ui.currentQuest) {
    const span = document.createElement('span');
    span.textContent = ui.currentQuest;
    cq.append('Quest: ', span);
  }

  const running = RUNNING.includes(ui.phase);
  $('btn-start').disabled = running;
  $('btn-stop').disabled  = !running;
}

// ── Communication with content script ────────────────────────────────────────

/**
 * Finds the Discord tab to drive: the active tab if it is Discord, else a
 * quest-home tab, else any Discord tab. Filters manually instead of using the
 * `url` query option, which Safari only honours for tabs it has permission on.
 */
async function getDiscordTab() {
  const [active] = await api.tabs.query({ active: true, currentWindow: true });
  if (active && DISCORD_RE.test(active.url || '')) return active;
  const tabs = (await api.tabs.query({})).filter(t => DISCORD_RE.test(t.url || ''));
  return tabs.find(t => t.url.includes('/quest-home')) || tabs[0] || null;
}

let warnedNoScript = false;

async function sendToContent(msg, { quiet = false } = {}) {
  const tab = await getDiscordTab();
  if (!tab) {
    applyState({ phase: 'no_tab' });
    if (!quiet) addLog('No Discord tab found — click Open Quests', 'error');
    return null;
  }
  try {
    return await api.tabs.sendMessage(tab.id, msg);
  } catch (_) {
    applyState({ phase: 'no_script' });
    if (!quiet || !warnedNoScript) {
      warnedNoScript = true;
      addLog('Content script not responding — reload discord.com' +
             (isSafari() ? ' and allow the extension on discord.com in Safari' : ''), 'warn');
    }
    return null;
  }
}

function isSafari() {
  return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
}

async function pollStatus() {
  const resp = await sendToContent({ action: 'getStatus' }, { quiet: true });
  if (resp) applyState(resp);
}

// ── Button handlers ───────────────────────────────────────────────────────────

$('btn-start').addEventListener('click', async () => {
  const resp = await sendToContent({ action: 'start' });
  if (resp) {
    applyState(resp);
    addLog('Automation started', 'good');
  }
});

$('btn-stop').addEventListener('click', async () => {
  const resp = await sendToContent({ action: 'stop' });
  if (resp) applyState(resp);
});

$('btn-open').addEventListener('click', async () => {
  const tab = await getDiscordTab();
  if (tab) await api.tabs.update(tab.id, { url: QUEST_HOME_URL, active: true });
  else     await api.tabs.create({ url: QUEST_HOME_URL });
  addLog('Opened quest-home', 'info');
});

$('btn-clear-log').addEventListener('click', () => {
  $('log-list').textContent = '';
});

// ── Push events from content script ──────────────────────────────────────────

api.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'orbCollectorEvent') return;
  applyState(msg.state || {});
  if (msg.log) addLog(msg.log.text, msg.log.level || 'info');
});

// ── Boot ─────────────────────────────────────────────────────────────────────

setInterval(pollStatus, 1200);
pollStatus();
