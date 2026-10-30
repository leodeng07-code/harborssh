export type AuthType = 'password' | 'key' | 'agent';
export type ConnectionProtocol = 'ssh' | 'telnet' | 'serial';
export interface SerialSettings {
  baudRate: number; dataBits: 5 | 6 | 7 | 8; stopBits: 1 | 2;
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
  flowControl: 'none' | 'hardware' | 'software'; localEcho: boolean; enterKey: 'cr' | 'crlf';
}
export interface SerialPortInfo { path: string; manufacturer?: string; serialNumber?: string; friendlyName?: string }
export interface Profile {
  id: string; name: string; host: string; port: number; username: string;
  group: string; groupPath?: string[]; authType: AuthType; privateKeyPath: string; agentPath: string;
  favorite: boolean; color: string; hasSecret: boolean; rememberSecret: boolean;
  protocol?: ConnectionProtocol; encoding?: 'utf8' | 'gb18030'; serial?: SerialSettings;
  telnetCredentialProfileId?: string;
}
export interface Secrets { password?: string; passphrase?: string }
export interface ProfileInput { profile: Profile; secrets?: Secrets; clearSecret?: boolean }
export interface Tunnel {
  id: string; name: string; profileId: string; type: 'local' | 'remote' | 'dynamic';
  bindHost: string; bindPort: number; targetHost: string; targetPort: number;
}
export type RunStatus = 'connecting' | 'connected' | 'closed' | 'error';
export interface TerminalLogInfo { status: 'recording' | 'saved' | 'error'; path: string; message?: string }
export interface SessionInfo { id: string; profileId: string; name: string; status: RunStatus; message?: string; connectedAt?: number; log?: TerminalLogInfo; protocol?: ConnectionProtocol; encoding?: 'utf8' | 'gb18030'; endpoint?: string }
export interface TunnelInfo { id: string; status: 'starting' | 'running' | 'stopped' | 'error'; message?: string; startedAt?: number; connections: number }
export interface BatchResult { profileId: string; name: string; status: 'queued' | 'running' | 'success' | 'unconfirmed' | 'error' | 'cancelled'; output: string; error?: string; warning?: string; exitCode?: number; duration?: number }
export interface BatchJob { id: string; command: string; startedAt: number; status: 'running' | 'done' | 'cancelled'; results: BatchResult[] }
export interface RuntimeSnapshot { sessions: SessionInfo[]; tunnels: TunnelInfo[]; jobs: BatchJob[] }
export interface Config { profiles: Profile[]; tunnels: Tunnel[]; snmp?: SnmpTarget[]; terminalLogDirectory?: string }
export type PortParameter = 'pvid' | 'vlanMode' | 'speed' | 'duplex';
export interface ParameterDefinition { field: PortParameter; oid: string; index: 'ifIndex' | 'bridgePort'; type: 'Integer' | 'Unsigned32' | 'OctetString' | 'OID'; choices: { label: string; value: string | number }[] }
export interface SnmpTuning { timeoutMs?: number; retries?: number; maxRepetitions?: number }
export interface SnmpTarget extends SnmpTuning { profileId: string; port: number; hasReadCommunity: boolean; hasWriteCommunity: boolean; parameters?: ParameterDefinition[] }
export interface SnmpConfigInput extends SnmpTuning { profileId: string; port: number; readCommunity?: string; writeCommunity?: string; clearWrite?: boolean; parameters?: ParameterDefinition[] }
export interface BatchSnmpConfigInput { profileIds: string[]; port?: number; readCommunity: string; writeCommunity?: string; clearWrite?: boolean }
export interface NetworkInterface { index: number; name: string; description: string; alias: string; adminStatus?: number; operStatus?: number; speedMbps?: number; mac: string; bridgePort?: number; duplexStatus?: number; parameters: Partial<Record<PortParameter, string | number>> }
export interface InterfaceSnapshot { profileId: string; host: string; name: string; objectId: string; description: string; interfaces: NetworkInterface[]; warnings: string[]; readAt: number }
export interface InterfaceChange { profileId: string; index: number; field: 'adminStatus' | 'alias' | PortParameter; value: number | string; expected: number | string }
export interface InterfaceChangeResult { verified: boolean; message: string }
export interface PortModeInfo { kind: 'access' | 'trunk' | 'hybrid' | 'other' | 'unknown'; label: string; source?: string; oid?: string; value?: number | string; reason?: string }
export interface MacMatch { bridgePort: number; ifIndex?: number; interfaceName: string; fdbId?: number; vlans: number[]; source: 'Q-BRIDGE' | 'BRIDGE'; entryStatus?: number; portMode?: PortModeInfo }
export interface MacLookup { profileId: string; host: string; mac: string; matches: MacMatch[]; warnings: string[]; readAt: number; available?: boolean }
export interface LldpNeighbor { key: string; timeMark: number; localPortNumber: number; remoteIndex: number; localPortId: string; localPortDescription: string; chassisId: string; portId: string; portDescription: string; systemName: string; systemDescription: string; managementAddresses: string[]; supportedCapabilities: string[]; enabledCapabilities: string[] }
export interface LldpSnapshot { profileId: string; host: string; localName: string; available: boolean; neighbors: LldpNeighbor[]; warnings: string[]; readAt: number }
export type NetworkQueryKind = 'auto' | 'arp' | 'routes' | 'ipInterfaces' | 'mac';
export interface NetworkQueryRequest { profileIds: string[]; kind: NetworkQueryKind; query: string }
export interface NetworkQueryRow {
  key: string; kind: 'arp' | 'routes' | 'ipInterfaces' | 'mac'; source: string;
  ifIndex?: number; interfaceName: string; ip?: string; prefixLength?: number; mask?: string; mac?: string;
  nextHop?: string; protocol?: string; metric?: number; type?: string; state?: string;
  adminStatus?: number; operStatus?: number; description?: string; policy?: string; vlans?: number[];
  portMode?: PortModeInfo;
}
export interface NetworkQueryData { rows: NetworkQueryRow[]; warnings: string[]; available: boolean; readAt: number }
export interface NetworkQueryDevice {
  profileId: string; name: string; host: string; group: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'; data?: NetworkQueryData; error?: string;
}
export interface NetworkQueryJob {
  id: string; kind: NetworkQueryKind; query: string; status: 'running' | 'done' | 'cancelled';
  startedAt: number; finishedAt?: number; devices: NetworkQueryDevice[];
}
export interface InitialState { config: Config; runtime: RuntimeSnapshot; version: string; secureStorage: boolean; platform: string }
export type AppEvent = { type: 'runtime'; data: RuntimeSnapshot } | { type: 'terminal'; id: string; seq: number; data: string } | { type: 'transfers'; sessionId: string; data: FileTransfer[] } | { type: 'notice'; message: string; error?: boolean } | { type: 'windowVisibility'; visible: boolean };
export interface RemoteFile { name: string; path: string; type: 'directory' | 'file' | 'link' | 'other'; size: number; modified: number; mode: number }
export interface RemoteDirectory { path: string; entries: RemoteFile[]; transport?: 'shared' | 'separate' }
export interface FileTransfer { id: string; sessionId: string; name: string; direction: 'upload' | 'download'; status: 'queued' | 'preparing' | 'running' | 'success' | 'error' | 'cancelled'; bytes: number; total: number; files: number; completed: number; destination: string; message?: string }
export interface TerminalBuffer { seq: number; data: string[] }
export interface SystemMemory { total: number; used: number; available: number; percent: number; estimated?: boolean }
export interface SystemDisk { device: string; mount: string; total: number; used: number; available: number; percent: number }
export interface SystemNetwork { name: string; received: number; sent: number; receiveRate?: number; sendRate?: number }
export interface SystemSnapshot { sessionId: string; platform: 'linux' | 'unsupported'; reason?: string; readAt: number; hostname?: string; release?: string; kernel?: string; cores?: number; uptime?: number; load?: number[]; cpuPercent?: number; memory?: SystemMemory; swap?: SystemMemory; disks: SystemDisk[]; networks: SystemNetwork[]; warnings: string[] }
export interface ImportRow { row: number; name: string; host: string; port: number; username: string; group: string; authType: string; hasSecret: boolean; duplicate: boolean; canFillSecret?: boolean; error?: string; protocol?: string }
export interface ImportPreview { token: string; filename: string; rows: ImportRow[] }
export interface BatchRequest { profileIds: string[]; command: string; concurrency: number; timeout: number }
export interface DesktopAPI {
  lockStatus(): Promise<{ configured: boolean; unlocked: boolean }>;
  setupPassword(password: string): Promise<void>;
  unlock(password: string): Promise<void>;
  changePassword(current: string, next: string): Promise<void>;
  initial(): Promise<InitialState>;
  saveProfile(input: ProfileInput): Promise<Config>;
  deleteProfile(id: string): Promise<Config>;
  deleteProfiles(ids: string[]): Promise<Config>;
  saveTunnel(tunnel: Tunnel): Promise<Config>;
  deleteTunnel(id: string): Promise<Config>;
  connect(profileId: string): Promise<string>;
  disconnect(id: string): Promise<void>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  listSerialPorts(): Promise<SerialPortInfo[]>;
  sendBreak(id: string): Promise<void>;
  readTerminal(id: string): Promise<TerminalBuffer>;
  readSystem(id: string): Promise<SystemSnapshot>;
  chooseLogDirectory(): Promise<Config | null>;
  openLogDirectory(): Promise<void>;
  sftpList(sessionId: string, path: string): Promise<RemoteDirectory>;
  sftpUpload(sessionId: string, directory: string, folder: boolean, overwrite: boolean): Promise<void>;
  sftpDownload(sessionId: string, paths: string[], overwrite: boolean): Promise<void>;
  sftpMkdir(sessionId: string, directory: string, name: string): Promise<void>;
  sftpRename(sessionId: string, path: string, name: string): Promise<void>;
  sftpDelete(sessionId: string, paths: string[]): Promise<{ path: string; error?: string }[]>;
  sftpTransfers(sessionId: string): Promise<FileTransfer[]>;
  sftpCancel(id: string): Promise<void>;
  startTunnel(id: string): Promise<void>;
  stopTunnel(id: string): Promise<void>;
  runBatch(request: BatchRequest): Promise<string>;
  cancelBatch(id: string): Promise<void>;
  snmpConfigure(input: SnmpConfigInput): Promise<Config>;
  snmpConfigureBatch(input: BatchSnmpConfigInput): Promise<Config>;
  snmpInterfaces(profileId: string): Promise<InterfaceSnapshot>;
  snmpChange(input: InterfaceChange): Promise<InterfaceChangeResult>;
  snmpMac(profileId: string, mac: string): Promise<MacLookup>;
  snmpLldp(profileId: string): Promise<LldpSnapshot>;
  networkQuery(request: NetworkQueryRequest): Promise<string>;
  networkQueryRead(id: string): Promise<NetworkQueryJob>;
  networkQueryCancel(id: string): Promise<void>;
  windowVisible(): Promise<boolean>;
  pickKey(): Promise<string | null>;
  importPreview(): Promise<ImportPreview | null>;
  importCommit(token: string, rows: number[], remember: boolean, fillMissing?: boolean): Promise<Config>;
  importCancel(token: string): Promise<void>;
  saveTemplate(): Promise<boolean>;
  exportConfig(): Promise<boolean>;
  resetTrust(profileId: string): Promise<boolean>;
  copy(text: string): Promise<void>;
  paste(): Promise<string>;
  window(action: 'minimize' | 'maximize' | 'close'): void;
  onEvent(callback: (event: AppEvent) => void): () => void;
}
declare global { interface Window { harbor?: DesktopAPI } }
