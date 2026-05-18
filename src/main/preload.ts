import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './ipc-channels';

/**
 * The preload script runs in an isolated context with access to a subset of
 * Node APIs. We expose a minimal, typed surface to the renderer via
 * contextBridge so the renderer never touches Electron internals directly.
 */
contextBridge.exposeInMainWorld('api', {
  config: {
    get: () => ipcRenderer.invoke(IPC.CONFIG_GET),
    save: (cfg: unknown) => ipcRenderer.invoke(IPC.CONFIG_SAVE, cfg),
  },
  agent: {
    start: () => ipcRenderer.invoke(IPC.AGENT_START),
    stop: () => ipcRenderer.invoke(IPC.AGENT_STOP),
    state: () => ipcRenderer.invoke(IPC.AGENT_STATE),
    onStateChanged: (cb: (state: unknown) => void) => {
      const listener = (_: unknown, state: unknown) => cb(state);
      ipcRenderer.on(IPC.AGENT_STATE_CHANGED, listener);
      return () => ipcRenderer.off(IPC.AGENT_STATE_CHANGED, listener);
    },
  },
  logs: {
    recent: () => ipcRenderer.invoke(IPC.LOG_RECENT),
    onEvent: (cb: (event: unknown) => void) => {
      const listener = (_: unknown, event: unknown) => cb(event);
      ipcRenderer.on(IPC.LOG_EVENT, listener);
      return () => ipcRenderer.off(IPC.LOG_EVENT, listener);
    },
  },
  dialog: {
    pickDir: (current?: string) => ipcRenderer.invoke(IPC.DIALOG_PICK_DIR, current),
  },
});
