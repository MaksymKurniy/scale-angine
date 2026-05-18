/* eslint-disable no-undef */
// Plain JS renderer (no bundler needed). Talks to main via window.api.

const fields = {
  sftpUri: document.getElementById('sftpUri'),
  sftpPassword: document.getElementById('sftpPassword'),
  folderName: document.getElementById('folderName'),
  importDirectory: document.getElementById('importDirectory'),
  exportDirectory: document.getElementById('exportDirectory'),
};

const btnShowPassword = document.getElementById('btn-show-password');

const btnStart = document.getElementById('btn-start');
const btnSave = document.getElementById('btn-save');
const btnStop = document.getElementById('btn-stop');
const logsEl = document.getElementById('logs');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

function readForm() {
  return {
    sftpUri: fields.sftpUri.value.trim(),
    // Password is intentionally NOT trimmed — trailing/leading spaces inside
    // an SFTP password are legal characters.
    sftpPassword: fields.sftpPassword.value,
    folderName: fields.folderName.value.trim(),
    importDirectory: fields.importDirectory.value.trim(),
    exportDirectory: fields.exportDirectory.value.trim(),
  };
}

function applyConfig(cfg) {
  if (!cfg) return;
  fields.sftpUri.value = cfg.sftpUri || '';
  fields.sftpPassword.value = cfg.sftpPassword || '';
  fields.folderName.value = cfg.folderName || '';
  fields.importDirectory.value = cfg.importDirectory || '';
  fields.exportDirectory.value = cfg.exportDirectory || '';
}

function applyState(state) {
  if (!state) return;
  statusDot.classList.remove('status-dot--idle', 'status-dot--running', 'status-dot--error');
  let label = 'Idle';
  if (state.status === 'running') {
    statusDot.classList.add('status-dot--running');
    label = 'Running';
  } else if (state.status === 'error') {
    statusDot.classList.add('status-dot--error');
    label = `Error: ${state.lastError || 'unknown'}`;
  } else {
    statusDot.classList.add('status-dot--idle');
  }
  statusText.textContent = label;
  btnStart.disabled = state.status === 'running';
  btnStop.disabled = state.status !== 'running';
}

function appendLog(evt) {
  if (!evt) return;
  const line = document.createElement('div');
  line.className = `log-line log-${evt.level || 'info'}`;
  const ts = document.createElement('span');
  ts.className = 'log-ts';
  const d = new Date(evt.ts);
  ts.textContent = d.toLocaleTimeString();
  const src = document.createElement('span');
  src.className = 'log-src';
  src.textContent = `[${evt.source}]`;
  const msg = document.createElement('span');
  msg.className = 'log-msg';
  msg.textContent = evt.message;
  line.appendChild(ts);
  line.appendChild(src);
  line.appendChild(msg);
  logsEl.appendChild(line);
  // Limit to last 300 lines
  while (logsEl.childElementCount > 300) logsEl.removeChild(logsEl.firstChild);
  logsEl.scrollTop = logsEl.scrollHeight;
}

async function init() {
  try {
    const cfg = await window.api.config.get();
    applyConfig(cfg);
  } catch (err) {
    appendLog({ ts: new Date().toISOString(), level: 'error', source: 'UI', message: `Failed to load config: ${err.message}` });
  }

  try {
    const state = await window.api.agent.state();
    applyState(state);
  } catch { /* ignore */ }

  try {
    const recent = await window.api.logs.recent();
    if (Array.isArray(recent)) recent.forEach(appendLog);
  } catch { /* ignore */ }

  window.api.agent.onStateChanged(applyState);
  window.api.logs.onEvent(appendLog);
}

// ---- Buttons ----

btnSave.addEventListener('click', async () => {
  try {
    const saved = await window.api.config.save(readForm());
    applyConfig(saved);
    appendLog({ ts: new Date().toISOString(), level: 'success', source: 'UI', message: 'Configuration saved' });
  } catch (err) {
    appendLog({ ts: new Date().toISOString(), level: 'error', source: 'UI', message: `Save failed: ${err.message}` });
  }
});

btnStart.addEventListener('click', async () => {
  // Save first so the agent reads the latest form values
  try {
    await window.api.config.save(readForm());
  } catch (err) {
    appendLog({ ts: new Date().toISOString(), level: 'error', source: 'UI', message: `Save before start failed: ${err.message}` });
    return;
  }
  btnStart.disabled = true;
  try {
    await window.api.agent.start();
  } catch (err) {
    appendLog({ ts: new Date().toISOString(), level: 'error', source: 'UI', message: `Start failed: ${err.message}` });
    btnStart.disabled = false;
  }
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  try {
    await window.api.agent.stop();
  } catch (err) {
    appendLog({ ts: new Date().toISOString(), level: 'error', source: 'UI', message: `Stop failed: ${err.message}` });
  }
});

// ---- Folder pickers ----

document.querySelectorAll('.btn-folder[data-target]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = btn.getAttribute('data-target');
    if (!target || !fields[target]) return;
    try {
      const picked = await window.api.dialog.pickDir(fields[target].value);
      if (picked) fields[target].value = picked;
    } catch (err) {
      appendLog({ ts: new Date().toISOString(), level: 'error', source: 'UI', message: `Folder pick failed: ${err.message}` });
    }
  });
});

// ---- Password show/hide ----

if (btnShowPassword) {
  btnShowPassword.addEventListener('click', () => {
    const next = fields.sftpPassword.type === 'password' ? 'text' : 'password';
    fields.sftpPassword.type = next;
    btnShowPassword.textContent = next === 'text' ? '🙈' : '👁';
  });
}

init();
