import { app, BrowserWindow, dialog } from 'electron';
import * as path from 'path';
import { bootstrapNest, NestContext } from './nest/bootstrap';
import { registerIpc } from './ipc';

let mainWindow: BrowserWindow | null = null;
let nestCtx: NestContext | null = null;

// Last-resort safety net so an unhandled crash inside the renderer or watcher
// surfaces in the agent log instead of silently killing the process.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  try { nestCtx?.logger.error('main', `Uncaught: ${err.message}`); } catch { /* ignore */ }
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  try { nestCtx?.logger.error('main', `Unhandled rejection: ${String(reason)}`); } catch { /* ignore */ }
});

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 720,
    height: 820,
    minWidth: 520,
    minHeight: 640,
    title: 'Scale Angine',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Renderer assets are copied to dist/renderer by scripts/copy-renderer.js
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Confirm-on-close while the agent is actively running. Prevents the cashier
  // from accidentally tearing down SFTP mid-receipt by closing the window.
  win.on('close', (e) => {
    const running = nestCtx?.agent.getState().status === 'running';
    if (!running) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Cancel', 'Stop & Quit'],
      defaultId: 0,
      cancelId: 0,
      title: 'Scale Angine is running',
      message: 'The agent is currently transferring files.',
      detail: 'Quitting now will stop the SFTP session. Continue?',
    });
    if (choice === 0) {
      e.preventDefault();
    }
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

async function init() {
  // Place config file inside Electron's per-user data dir
  const configFilePath = path.join(app.getPath('userData'), 'scale-angine-config.json');
  nestCtx = await bootstrapNest(configFilePath);

  mainWindow = createWindow();
  registerIpc(nestCtx, () => mainWindow);
}

app.whenReady().then(init).catch((err) => {
  console.error('Failed to init Scale Angine:', err);
  app.quit();
});

app.on('window-all-closed', async () => {
  // Make sure the agent is stopped & SFTP closed cleanly before quitting
  try { await nestCtx?.agent.stop(); } catch { /* ignore */ }
  try { await nestCtx?.app.close(); } catch { /* ignore */ }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
    if (nestCtx) registerIpc(nestCtx, () => mainWindow);
  }
});
