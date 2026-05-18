// IPC channel names — shared (string-typed) between main and preload/renderer.
// Keep this file dependency-free; it's loaded from the preload script which
// runs in a restricted context.

export const IPC = {
  CONFIG_GET: 'config:get',
  CONFIG_SAVE: 'config:save',
  AGENT_START: 'agent:start',
  AGENT_STOP: 'agent:stop',
  AGENT_STATE: 'agent:state',
  AGENT_STATE_CHANGED: 'agent:state-changed',
  LOG_EVENT: 'log:event',
  LOG_RECENT: 'log:recent',
  DIALOG_PICK_DIR: 'dialog:pick-dir',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
