'use strict';

// ── Helpers ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function timestamp() {
  const d = new Date();
  return d.getHours().toString().padStart(2,'0') + ':' +
         d.getMinutes().toString().padStart(2,'0') + ':' +
         d.getSeconds().toString().padStart(2,'0');
}

function addLog(msg, type = 'info') {
  const ul = $('log-list');
  const li = document.createElement('li');
  li.className = type;
  li.innerHTML = '<span class="ts">' + timestamp() + '</span>' +
                 '<span class="msg">' + msg + '</span>';
  ul.appendChild(li);
  // keep only last 40 entries
  while (ul.children.length > 40) ul.removeChild(ul.firstChild);
  ul.scrollTop = ul.scrollHeight;
}

// ── State reflected in the popup ─────────────────────────────────────────────

const ui = {
  phase:       'idle',
  questsDone:  0,
  questQueue:  0,
  orbBalance:  null,
  currentQuest: null,
  videoProgress: 0,   // 0-100
};

// Phase → dot class + status text
const PHASE_META = {
  boot:       { dot: 'idle',    text: 'Starting up…' },
  idle:       { dot: 'idle',    text: 'Idle — ready to run' },
  navigating: { dot: 'running', text: 'Navigating to quest-home…' },
  scanning:   { dot: 'running', text: 'Scanning for quests…' },
  watching:   { dot: 'running', text: 'Watching video…' },
  captcha:    { dot: 'captcha', text: 'Waiting for captcha…' },
  claiming:   { dot: 'running', text: 'Claiming reward…' },
  dismissing: { dot: 'running', text: 'Dismissing modal…' },
  done:       { dot: 'done',    text: 'All quests complete! 🎉' },
  stopped:    { dot: 'idle',    text: 'Stopped by user' },
  error:      { dot: 'error',   text: 'Error — check console' },
  no_tab:     { dot: 'error',   text: 'No Discord tab found' },
};

function applyState(s) {
  // merge incoming state into ui
  if (s.phase       !== undefined) ui.phase       = s.phase;
  if (s.questsDone  !== undefined) ui.questsDone  = s.questsDone;
  if (s.questQueue  !== undefined) ui.questQueue  = s.questQueue;
  if (s.orbBalance  !== undefined) ui.orbBalance  = s.orbBalance;
  if (s.currentQuest!== undefined) ui.currentQuest= s.currentQuest;
  if (s.videoProgress!==undefined) ui.videoProgress= s.videoProgress;

  const meta = PHASE_META[ui.phase] || PHASE_META.idle;

  // dot
  const dot = $('dot');
  dot.className = 'dot ' + meta.dot;

  // status text
  $('status-text').textContent = meta.text;

  // stats
  $('stat-done').textContent  = ui.questsDone;
  $('stat-queue').textContent = ui.questQueue;
  $('stat-orbs').textContent  = ui.orbBalance !== null ? ui.orbBalance : '—';

  // progress bar
  const fill = $('progress-fill');
  const pct  = ui.videoProgress;
  fill.style.width = pct + '%';
  $('progress-pct').textContent   = pct > 0 ? pct + '%' : '';
  $('progress-label').textContent = ui.currentQuest
    ? 'Watching: ' + ui.currentQuest
    : (ui.phase === 'watching' ? 'Watching…' : 'No active quest');

  // current quest label
  const cq = $('current-quest');
  if (ui.currentQuest) {
    cq.innerHTML = 'Quest: <span>' + ui.currentQuest + '</span>';
  } else {
    cq.textContent = '';
  }

  // button states
  const running = ['navigating','scanning','watching','captcha','claiming','dismissing'].includes(ui.phase);
  $('btn-start').disabled = running;
  $('btn-stop').disabled  = !running;
}

// ── Communication with content script ────────────────────────────────────────

async function getActiveDiscordTab() {
  const tabs = await chrome.tabs.query({ url: 'https://discord.com/*' });
  if (!tabs.length) return null;
  // prefer quest-home tab, else first discord tab
  return tabs.find(t => t.url && t.url.includes('quest-home')) || tabs[0];
}

async function sendToContent(msg) {
  const tab = await getActiveDiscordTab();
  if (!tab) {
    applyState({ phase: 'no_tab' });
    addLog('No Discord tab found — open discord.com first', 'error');
    return null;
  }
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, msg);
    return resp;
  } catch (e) {
    addLog('Content script not responding — refresh discord.com', 'warn');
    return null;
  }
}

async function pollStatus() {
  const resp = await sendToContent({ action: 'getStatus' });
  if (resp) applyState(resp);
}

// ── Poll loop ────────────────────────────────────────────────────────────────

let pollTimer = null;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollStatus, 1200);
  pollStatus();   // immediate first tick
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// ── Button handlers ───────────────────────────────────────────────────────────

$('btn-start').addEventListener('click', async () => {
  addLog('Start requested', 'info');
  const resp = await sendToContent({ action: 'start' });
  if (resp) {
    applyState(resp);
    addLog('Automation started', 'good');
  }
});

$('btn-stop').addEventListener('click', async () => {
  addLog('Stop requested', 'warn');
  const resp = await sendToContent({ action: 'stop' });
  if (resp) {
    applyState(resp);
    addLog('Automation stopped', 'warn');
  }
});

$('btn-open').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: 'https://discord.com/*' });
  if (tabs.length) {
    chrome.tabs.update(tabs[0].id, { url: 'https://discord.com/quest-home', active: true });
  } else {
    chrome.tabs.create({ url: 'https://discord.com/quest-home' });
  }
  addLog('Opened quest-home', 'info');
});

$('btn-clear-log').addEventListener('click', () => {
  $('log-list').innerHTML = '';
});

// ── Listen for push events from content script ───────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'orbCollectorEvent') {
    applyState(msg.state || {});
    if (msg.log) {
      addLog(msg.log.text, msg.log.level || 'info');
    }
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────

addLog('Popup opened', 'info');
startPolling();

// Stop polling when popup closes to avoid ghost timers
window.addEventListener('unload', stopPolling);