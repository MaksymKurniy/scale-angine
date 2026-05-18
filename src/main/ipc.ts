import { BrowserWindow, dialog, ipcMain } from 'electron';
import { NestContext } from './nest/bootstrap';
import { AppConfig } from './nest/config/config.types';
import { IPC } from './ipc-channels';

/**
 * Wires NestJS services to Electron IPC handlers and pushes events
 * (agent state, logs) back to the renderer.
 */
export function registerIpc(ctx: NestContext, getWindow: () => BrowserWindow | null): void {
  const { agent, config, logger } = ctx;

  ipcMain.handle(IPC.CONFIG_GET, () => config.get());
  ipcMain.handle(IPC.CONFIG_SAVE, (_e, next: AppConfig) => config.save(next));

  ipcMain.handle(IPC.AGENT_START, async () => {
    try {
      return await agent.start();
    } catch (err) {
      // Surface the error to the renderer as a structured rejection
      throw new Error((err as Error).message);
    }
  });
  ipcMain.handle(IPC.AGENT_STOP, async () => agent.stop());
  ipcMain.handle(IPC.AGENT_STATE, () => agent.getState());

  ipcMain.handle(IPC.LOG_RECENT, () => logger.recent());

  ipcMain.handle(IPC.DIALOG_PICK_DIR, async (_e, current?: string) => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current && current.length ? current : undefined,
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  // Push agent state changes to renderer
  agent.onStateChange((state) => {
    const win = getWindow();
    win?.webContents.send(IPC.AGENT_STATE_CHANGED, state);
  });

  // Push log events to renderer
  logger.onLog((evt) => {
    const win = getWindow();
    win?.webContents.send(IPC.LOG_EVENT, evt);
  });
}
