import { spawn } from 'node:child_process';
import { JsonRpcProvider } from 'ethers';
import { readCanonicalChainPoint } from '../../../jurisdiction/adapter/stack-manager/receipts';
import { readProof, requireSameRestoredProof } from './evidence';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCliOption } from '../../../config/cli';
import { requireBoundaryRecord } from '../../../protocol/boundary-validation';
import { safeStringify } from '../../../protocol/serialization';
import { decodeCommittedCrossRoutes } from '../../../scripts/operations/hlt/cross/cross-boundary';
import { getCrossJurisdictionRouteRemainingAmounts } from '../../../extensions/cross-j/orderbook';
import { connectPocHub } from '../hub-proof';
import { waitFor } from '../user';
import { postRecoveryMakerQuote } from './liquidity';
import { verifyRecoveredLedger } from './ledger';

const args = process.argv.slice(2);
const apiBase = readCliOption(args, '--api-base', '');
const workDir = readCliOption(args, '--work-dir', '');
const clearing = args.includes('--clear-remainder');
const userDirectory = clearing ? 'poc-expired-user' : 'poc-partial-user';
const directory = join(workDir, userDirectory);
const quote = await postRecoveryMakerQuote(workDir, `partial-${process.pid}`, 1);
const childArgs = [
  'core/scenarios/usdc-poc/source-funding.ts',
  '--api-base',
  apiBase,
  '--work-dir',
  workDir,
  '--user-directory',
  userDirectory,
  '--external-payout',
  '--partial-liquidity',
  '--duplicate-account-delivery',
  ...(clearing ? ['--expires-in-ms', '30000'] : []),
];
const child = spawn(process.execPath, [...childArgs, '--interrupt-point', 'observe'], {
  stdio: 'inherit',
  env: process.env,
});
const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
const hub = await connectPocHub(workDir);
try {
  await waitFor(
    'partial-source-funded',
    () => existsSync(join(directory, 'source-funding.json')) || child.exitCode !== null,
  );
  if (child.exitCode !== null) throw new Error(`USDC_POC_PARTIAL_CHILD_EXITED:${child.exitCode}`);
  const source = requireBoundaryRecord(
    JSON.parse(readFileSync(join(directory, 'source-funding.json'), 'utf8')),
    'USDC_POC_PARTIAL_SOURCE_INVALID',
  );
  const orderId = source['orderId'];
  if (typeof orderId !== 'string' || !orderId) throw new Error('USDC_POC_PARTIAL_ORDER_ID_MISSING');
  let bookProof: { orderId: string; expiresAt: number | undefined; [key: string]: unknown } | undefined;
  await waitFor('real-partial-fill-before-close', async () => {
    const route = decodeCommittedCrossRoutes(await hub.read<unknown>(`entity/${quote.sourceHub}`)).find(
      item => item.orderId === orderId,
    );
    if (!route || route.status !== 'partially_filled') return false;
    const amounts = getCrossJurisdictionRouteRemainingAmounts(route);
    if (route.executionSourceAmount !== 500_000n || route.executionTargetAmount !== 500_000n || route.sourceCloseProof)
      return false;
    bookProof = {
      orderId,
      routeHash: route.routeHash,
      status: route.status,
      amounts,
      executionSourceAmount: route.executionSourceAmount,
      executionTargetAmount: route.executionTargetAmount,
      sourcePull: route.sourcePull,
      targetPull: route.targetPull,
      expiresAt: route.expiresAt,
      frame: await hub.read<unknown>('frame/latest'),
    };
    return true;
  });
  child.kill('SIGKILL');
  if ((await exited).signal !== 'SIGKILL') throw new Error('USDC_POC_PARTIAL_CHILD_NOT_KILLED');
  writeFileSync(
    join(directory, 'partial-interruption.json'),
    safeStringify(
      { bookProof, user: JSON.parse(readFileSync(join(directory, 'latest-commit.json'), 'utf8')) as unknown },
      2,
    ),
  );
  const port = Number(new URL(apiBase).port);
  const providers = [
    new JsonRpcProvider(`http://127.0.0.1:${port - 4}`),
    new JsonRpcProvider(`http://127.0.0.1:${port - 3}`),
  ];
  const chainBefore = await Promise.all(
    providers.map(async provider => {
      const point = await readCanonicalChainPoint(provider);
      const block = await provider.getBlock(point.number);
      if (!block) throw new Error('USDC_POC_RECOVERY_CHAIN_HEAD_MISSING');
      return {
        chainId: String((await provider.getNetwork()).chainId),
        number: block.number,
        timestamp: block.timestamp,
      };
    }),
  );
  if (clearing) {
    const expiresAt = bookProof?.expiresAt;
    if (!expiresAt) throw new Error('USDC_POC_RECOVERY_EXPIRY_MISSING');
    console.log(`USDC_POC_EXPIRY_WAIT:remainingMs=${Math.max(0, expiresAt - Date.now())}`);
    await waitFor('signed-book-ttl-elapsed-while-user-stopped', () => Date.now() > expiresAt);
  } else await postRecoveryMakerQuote(workDir, `partial-${process.pid}`, 2);
  await Promise.all(providers.map(provider => provider.send('evm_mine', [])));
  const chainAfter = await Promise.all(
    providers.map(async (provider, index) => {
      const point = await readCanonicalChainPoint(provider);
      const block = await provider.getBlock(point.number);
      const before = chainBefore[index];
      if (!block || !before || block.number <= before.number || block.timestamp <= before.timestamp)
        throw new Error('USDC_POC_RECOVERY_CHAIN_DID_NOT_ADVANCE');
      return { chainId: before.chainId, number: block.number, timestamp: block.timestamp };
    }),
  );
  for (const provider of providers) provider.destroy();
  writeFileSync(
    join(directory, 'offline-chain-time.json'),
    safeStringify({ chainBefore, chainAfter, clearing, deadlinesPaused: false }, 2),
  );
  let previous = readProof(join(directory, 'latest-commit.json'));
  const restores = [];
  for (const point of ['cross-closed', '']) {
    const resumed = spawn(
      process.execPath,
      [
        ...childArgs,
        '--resume',
        ...(clearing ? ['--clear-remainder'] : []),
        ...(point ? ['--interrupt-point', point] : []),
      ],
      { stdio: 'inherit', env: process.env },
    );
    await new Promise<void>((resolve, reject) => {
      resumed.once('error', reject);
      resumed.once('exit', (code, signal) =>
        (point ? signal === 'SIGKILL' : code === 0)
          ? resolve()
          : reject(new Error(`USDC_POC_PARTIAL_RESUME_FAILED:${code}:${signal}`)),
      );
    });
    const after = readProof(join(directory, 'restored.json'));
    requireSameRestoredProof(previous, after);
    restores.push({ before: previous, after });
    if (point) previous = readProof(join(directory, 'interruption.json'));
  }
  writeFileSync(
    join(directory, 'partial-recovery.json'),
    safeStringify({ bookProof, restores, chainBefore, chainAfter, clearing, fullSourcePocSuccess: !clearing }, 2),
  );
  if (!clearing) await verifyRecoveredLedger(apiBase, directory);
  console.log(`USDC_POC_PARTIAL_RECOVERY_COMPLETE:clearing=${clearing}`);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
  hub.disconnect();
}
