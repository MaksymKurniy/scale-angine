export interface AppConfig {
  /** SFTP URI, e.g. sftp://user@host:22 — password may be omitted and provided separately */
  sftpUri: string;
  /** Optional separate password — overrides any password embedded in `sftpUri` when non-empty */
  sftpPassword: string;
  /** Subfolder under /upload that this scale listens to (e.g. "DIsaH6") */
  folderName: string;
  /** Local directory where Mettler Toledo expects incoming product XMLs (we WRITE here) */
  importDirectory: string;
  /** Local directory from which Mettler Toledo emits receipt XMLs (we READ here) */
  exportDirectory: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  sftpUri: '',
  sftpPassword: '',
  folderName: '',
  importDirectory: '',
  exportDirectory: '',
};

export type AgentStatus = 'idle' | 'running' | 'error';

export interface AgentState {
  status: AgentStatus;
  lastError?: string;
  startedAt?: string;
}
