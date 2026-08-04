import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type BarStyle = 'closed' | 'twin';

export type CliSettings = {
  barStyle: BarStyle;
  apiBase: string;
  dbPath: string;
  homeDir: string;
  socketPath: string;
  profileName: string;
};

const DEFAULT_API_BASE = process.env['XLN_API_BASE']?.trim() || 'https://xln.finance';

export const resolveCliHome = (): string =>
  process.env['XLN_HOME']?.trim() || join(homedir(), '.xln');

export const defaultSettings = (): CliSettings => {
  const homeDir = resolveCliHome();
  return {
    barStyle: 'closed',
    apiBase: DEFAULT_API_BASE,
    dbPath: process.env['XLN_DB_PATH']?.trim() || join(homeDir, 'db'),
    homeDir,
    socketPath: process.env['XLN_CLI_SOCKET']?.trim() || join(homeDir, 'daemon.sock'),
    profileName: 'wallet',
  };
};

const settingsPath = (homeDir: string): string => join(homeDir, 'settings.json');

export const loadSettings = async (): Promise<CliSettings> => {
  const defaults = defaultSettings();
  try {
    const raw = await readFile(settingsPath(defaults.homeDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<CliSettings>;
    const barStyle = parsed.barStyle === 'twin' ? 'twin' : 'closed';
    return {
      ...defaults,
      ...parsed,
      barStyle,
      apiBase: String(parsed.apiBase || defaults.apiBase).replace(/\/$/, ''),
      dbPath: String(parsed.dbPath || defaults.dbPath),
      homeDir: defaults.homeDir,
      socketPath: String(parsed.socketPath || defaults.socketPath),
    };
  } catch {
    return defaults;
  }
};

export const saveSettings = async (settings: CliSettings): Promise<void> => {
  await mkdir(settings.homeDir, { recursive: true });
  const payload = {
    barStyle: settings.barStyle,
    apiBase: settings.apiBase,
    dbPath: settings.dbPath,
    socketPath: settings.socketPath,
    profileName: settings.profileName,
  };
  await writeFile(settingsPath(settings.homeDir), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

export const setBarStyle = async (barStyle: BarStyle): Promise<CliSettings> => {
  const settings = await loadSettings();
  settings.barStyle = barStyle;
  await saveSettings(settings);
  return settings;
};
