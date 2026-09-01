/**
 * One diagnostic entrypoint for every hot TS/Rust crypto primitive.
 * Suites execute sequentially under the package-level machine stand lock.
 */
import { spawn, type ChildProcess } from 'node:child_process';

import { safeParse } from '../../../../protocol/serialization';
import { terminateGateProcessGroup } from '../../../release/gate-child-process';

const BENCHMARK_BUDGET_MS = 30_000;
const TS_WORKERS = 8;
const RUST_MAX_WORKERS = 16;

type CryptoReport = Readonly<{
  authority: string;
  engine: string;
  count: number;
  workers: number;
  wallMs: Readonly<Record<string, number>>;
  rssBytes?: number;
}>;

type CryptoRow = Readonly<{
  engine: 'RS' | 'TS';
  workers: number;
  primitive: string;
  count: number;
  wallMs: number;
  microsPerOp: number;
  speedup: number;
}>;

const parseCount = (raw: string | undefined): number => {
  const value = raw === undefined ? 1_000 : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`CRYPTO_BENCH_COUNT_INVALID:${String(raw)}`);
  }
  return value;
};

const collectStream = (stream: NodeJS.ReadableStream): Promise<string> => new Promise((resolve, reject) => {
  let output = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => { output += String(chunk); });
  stream.once('end', () => resolve(output));
  stream.once('error', reject);
});

const waitForChild = (child: ChildProcess): Promise<number> => new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', code => resolve(code ?? 1));
});

const runSuite = async (command: string, args: readonly string[], deadline: number): Promise<string> => {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error('CRYPTO_BENCH_TIMEOUT_BEFORE_SUITE');
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = collectStream(child.stdout!);
  const stderr = collectStream(child.stderr!);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), remainingMs);
  });
  const outcome = await Promise.race([waitForChild(child), timeout]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timeout') {
    await terminateGateProcessGroup(child, 1_000);
    throw new Error(`CRYPTO_BENCH_TIMEOUT:${command}`);
  }
  const [out, err] = await Promise.all([stdout, stderr]);
  if (outcome !== 0) throw new Error(`CRYPTO_BENCH_CHILD_FAILED:${command}:${outcome}\n${err}`);
  if (err.trim()) process.stderr.write(err);
  return out;
};

const decodeReports = (output: string): CryptoReport[] => output
  .split('\n')
  .map(line => line.trim())
  .filter(line => line.startsWith('{'))
  .map(line => safeParse(line) as CryptoReport)
  .filter(report => report.authority === 'DIAGNOSTIC_ONLY_NOT_TPS');

const primitiveName = (raw: string): string => ({
  keccak256: 'Keccak-256',
  sha256: 'SHA-256',
  hmacSha256: 'HMAC-SHA256',
  x25519: 'X25519',
  ecdsaSign: 'ECDSA sign',
  ecdsaSignSequential: 'ECDSA sign',
  ecdsaSignBatch: 'ECDSA sign',
  ecdsaRecoverAddress: 'ECDSA recover+address',
  ecdsaRecoverAddressSequential: 'ECDSA recover+address',
  ecdsaRecoverAddressBatch: 'ECDSA recover+address',
  ecdsaKnownKeyVerify: 'ECDSA known-key verify',
})[raw] ?? raw;

const effectiveWorkers = (report: CryptoReport, raw: string): number =>
  report.engine.startsWith('ts-') && !raw.endsWith('Batch') ? 1 : report.workers;

const buildRows = (reports: readonly CryptoReport[]): CryptoRow[] => {
  const provisional = reports.flatMap(report => Object.entries(report.wallMs).map(([raw, wallMs]) => ({
    engine: report.engine.startsWith('ts-') ? 'TS' as const : 'RS' as const,
    workers: effectiveWorkers(report, raw),
    primitive: primitiveName(raw),
    count: report.count,
    wallMs,
    microsPerOp: wallMs * 1_000 / report.count,
  })));
  const baselines = new Map<string, number>();
  for (const row of provisional) {
    if (row.workers === 1) baselines.set(`${row.engine}:${row.primitive}`, row.wallMs);
  }
  return provisional.map(row => ({
    ...row,
    speedup: (baselines.get(`${row.engine}:${row.primitive}`) ?? row.wallMs) / row.wallMs,
  })).sort((left, right) => left.microsPerOp - right.microsPerOp);
};

const pad = (value: string, width: number, right = false): string =>
  right ? value.padStart(width) : value.padEnd(width);

const printRows = (rows: readonly CryptoRow[]): void => {
  const header = ['#', 'Engine', 'W', 'Primitive', 'Count', 'Wall ms', 'µs/op', 'vs W1'];
  const widths = [3, 6, 3, 25, 9, 11, 11, 8];
  const render = (values: readonly string[]): string => values
    .map((value, index) => pad(value, widths[index]!, index === 0 || index >= 2))
    .join(' | ');
  console.log(render(header));
  console.log(widths.map(width => '-'.repeat(width)).join('-+-'));
  rows.forEach((row, index) => console.log(render([
    String(index + 1), row.engine, String(row.workers), row.primitive,
    String(row.count), row.wallMs.toFixed(3), row.microsPerOp.toFixed(3), `${row.speedup.toFixed(2)}x`,
  ])));
};

const count = parseCount(process.argv[2]);
if (process.argv.length > 3) throw new Error('CRYPTO_BENCH_ARGUMENTS_INVALID');
const deadline = Date.now() + BENCHMARK_BUDGET_MS;
const tsOutput = await runSuite('bun', [
  'core/scripts/operations/benchmark/crypto/crypto-primitives.ts',
  `--count=${count}`,
  `--workers=${TS_WORKERS}`,
], deadline);
const rustOutput = await runSuite('cargo', [
  'bench', '--quiet', '--manifest-path', 'rscore/Cargo.toml', '-p',
  'xln-rscore-crypto', '--bench', 'crypto_primitives', '--',
  String(count), String(RUST_MAX_WORKERS),
], deadline);
const reports = [...decodeReports(tsOutput), ...decodeReports(rustOutput)];
if (reports.length !== 5) throw new Error(`CRYPTO_BENCH_REPORT_COUNT_INVALID:${reports.length}`);
console.log(`CRYPTO BENCH — DIAGNOSTIC ONLY, NOT TPS — ${count} operations per row`);
printRows(buildRows(reports));
for (const report of reports) {
  if (report.rssBytes !== undefined) console.log(`${report.engine} rssMiB=${(report.rssBytes / 2 ** 20).toFixed(1)}`);
}
