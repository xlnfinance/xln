import { readFileSync } from 'node:fs';

const MIB = 1024 * 1024;
const MAX_SAFE_ANVIL_RSS = 768 * MIB;
const MIN_KILL_TIMEOUT_MS = 60_000;
const MIN_RESTART_DELAY_MS = 2_000;

type Pm2Entry = {
  name?: unknown;
  pid?: unknown;
  pm2_env?: {
    args?: unknown;
    kill_timeout?: unknown;
    max_memory_restart?: unknown;
    restart_delay?: unknown;
    status?: unknown;
  };
};

const fail = (code: string, detail: string): never => {
  throw new Error(`${code}:${detail}`);
};

const normalizedArgs = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
};

export const validateAnvilSupervision = (
  entries: readonly Pm2Entry[],
  readProcessName: (pid: number) => string,
): Array<{ name: string; pid: number; maxMemoryBytes: number }> => {
  return ['anvil', 'anvil2'].map((name) => {
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry) fail('ANVIL_PM2_ENTRY_MISSING', name);
    const env = entry.pm2_env;
    if (!env || env.status !== 'online') fail('ANVIL_PM2_NOT_ONLINE', name);
    if (normalizedArgs(env.args).includes('--reset')) fail('ANVIL_PM2_DESTRUCTIVE_ARG', name);

    const pid = Number(entry.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) fail('ANVIL_PM2_PID_INVALID', `${name}:${entry.pid}`);
    const processName = readProcessName(pid).trim();
    if (processName !== 'anvil') fail('ANVIL_PM2_WRONG_PROCESS', `${name}:pid=${pid}:comm=${processName}`);

    const maxMemoryBytes = Number(env.max_memory_restart);
    if (!Number.isSafeInteger(maxMemoryBytes) || maxMemoryBytes <= 0 || maxMemoryBytes > MAX_SAFE_ANVIL_RSS) {
      fail('ANVIL_PM2_MEMORY_LIMIT_INVALID', `${name}:${env.max_memory_restart}`);
    }
    const killTimeout = Number(env.kill_timeout);
    if (!Number.isSafeInteger(killTimeout) || killTimeout < MIN_KILL_TIMEOUT_MS) {
      fail('ANVIL_PM2_KILL_TIMEOUT_INVALID', `${name}:${env.kill_timeout}`);
    }
    const restartDelay = Number(env.restart_delay);
    if (!Number.isSafeInteger(restartDelay) || restartDelay < MIN_RESTART_DELAY_MS) {
      fail('ANVIL_PM2_RESTART_DELAY_INVALID', `${name}:${env.restart_delay}`);
    }
    return { name, pid, maxMemoryBytes };
  });
};

const main = (): void => {
  const result = Bun.spawnSync(['pm2', 'jlist'], { stdout: 'pipe', stderr: 'inherit' });
  if (result.exitCode !== 0) fail('ANVIL_PM2_LIST_FAILED', `exit=${result.exitCode}`);
  const entries = JSON.parse(result.stdout.toString()) as Pm2Entry[];
  const verified = validateAnvilSupervision(
    entries,
    (pid) => readFileSync(`/proc/${pid}/comm`, 'utf8'),
  );
  console.log(JSON.stringify({ ok: true, verified }));
};

if (import.meta.main) main();
