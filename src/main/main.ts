import { app, BrowserWindow, dialog } from 'electron';
import * as fs from 'fs';
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
    title: 'Scale Engine',
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
      title: 'Scale Engine is running',
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

/**
 * One-off migration from the pre-1.1 productName ("Scale Angine") to the
 * new one ("Scale Engine"). Electron builds userData path from productName,
 * so on the rename Electron would otherwise hand us a fresh empty folder
 * and the client would lose their four config fields.
 *
 * We look for a config in the old sibling folder and copy it over on
 * first run of the new build. Safe to leave in perpetuity — it's a no-op
 * after the first successful migration.
 */
function migrateLegacyUserData(newUserDataDir: string): void {
  const parent = path.dirname(newUserDataDir);
  const legacyDir = path.join(parent, 'Scale Angine');
  const newConfigPath = path.join(newUserDataDir, 'scale-angine-config.json');
  const legacyConfigPath = path.join(legacyDir, 'scale-angine-config.json');
  try {
    if (fs.existsSync(newConfigPath)) return; // already migrated or fresh install
    if (!fs.existsSync(legacyConfigPath)) return; // nothing to migrate
    fs.mkdirSync(newUserDataDir, { recursive: true });
    fs.copyFileSync(legacyConfigPath, newConfigPath);
    console.log(`[migration] copied config from "${legacyConfigPath}" to "${newConfigPath}"`);
  } catch (err) {
    console.warn(`[migration] userData migration failed (non-fatal): ${(err as Error).message}`);
  }
}

async function init() {
  const userDataDir = app.getPath('userData');
  migrateLegacyUserData(userDataDir);

  // Config filename kept as `scale-angine-config.json` (not renamed) so
  // that the migrated legacy file is picked up transparently.
  const configFilePath = path.join(userDataDir, 'scale-angine-config.json');
  nestCtx = await bootstrapNest(configFilePath);

  mainWindow = createWindow();
  registerIpc(nestCtx, () => mainWindow);
}

app.whenReady().then(init).catch((err) => {
  console.error('Failed to init Scale Engine:', err);
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
