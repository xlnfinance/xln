/**
 * One-shot text profile: in-memory orderbook vs one Account frame of 1000 swap txs.
 * Does not shard. Does not claim Runtime/WAL/network TPS.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runSwapOrderbookBenchmark } from './bench-swap-orderbook-tps';
import {
  buildHubConsensusCases,
  makeHubConsensusEnv,
  runHubConsensusMeasuredCases,
} from './bench-swap-hub-consensus-tps';
import { registerStructuredLogSink } from '../../../support/logger';
import { computeAccountStateRoot } from '../../../account/commitment/state-root';
import { getPerfMs } from '../../../support/time';
import {
  diffOpCounters,
  dumpOpCounters,
  installGlobalOpCounters,
  snapshotOpCallSites,
  snapshotOpCounters,
  type OpCounterSnapshot,
} from '../../../support/performance/op-counters';
import {
  dumpRuntimeSamplingProfile,
  startRuntimeSamplingProfiler,
} from '../../../support/performance/sampling-profiler';
import {
  formatExclusiveSampling,
  summarizeExclusiveSampling,
  type SamplingDump,
} from '../../../support/performance/sampling-summary';

const OUT = String(process.env['XLN_FRAME_PROFILE_DIR'] || '/tmp/xln-1000tx-prof');
const proposalProfiles: Array<Record<string, unknown>> = [];
registerStructuredLogSink(event => {
  if (event.scope === 'account' && event.message === 'proposal.profile') {
    proposalProfiles.push({
      txs: event['txs'],
      txTypes: event['txTypes'],
      optimisticBatch: event['optimisticBatch'],
      totalMs: event['totalMs'],
      phases: event['phases'],
      stateRoot: event['stateRoot'],
    });
  }
});

const summarizeSamples = (path: string, top = 25): string[] => {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const dump = (Array.isArray(raw) ? { traces: raw } : raw) as SamplingDump;
  return [
    `file=${path}`,
    ...formatExclusiveSampling(summarizeExclusiveSampling(dump, top)),
  ];
};

const printOps = (label: string, counters: OpCounterSnapshot, swaps: number): void => {
  const rows = Object.entries(counters)
    .map(([name, counter]) => ({
      name,
      calls: counter.calls,
      bytes: counter.bytes,
      perSwap: counter.calls / Math.max(swaps, 1),
    }))
    .sort((left, right) => right.calls - left.calls)
    .slice(0, 20);
  console.log(`\n== ${label} ops ==`);
  for (const row of rows) {
    console.log(
      `${row.calls.toString().padStart(8)} calls  ${row.perSwap.toFixed(1).padStart(8)}/swap  ${(row.bytes / 1e6).toFixed(1).padStart(8)} MB  ${row.name}`,
    );
  }
};

const printSites = (name: string): void => {
  const sites = snapshotOpCallSites()[name] ?? [];
  if (sites.length === 0) return;
  console.log(`\n== ${name} call sites (1/16 sample) ==`);
  for (const site of sites.slice(0, 8)) {
    console.log(`  n=${site.samples}  ${site.site.replaceAll('/Users/zigota/xln/', '')}`);
  }
};

mkdirSync(OUT, { recursive: true });
mkdirSync(`${OUT}/samples`, { recursive: true });
await installGlobalOpCounters('frame-1000');

const orderbook = runSwapOrderbookBenchmark({
  swaps: 100_000,
  warmup: 10_000,
  minTps: 10_000,
  levels: 32,
  bookCommandsPerOverlay: 160,
});
console.log('\n== orderbook matcher (no Account, no Entity, no WAL) ==');
console.log(JSON.stringify(orderbook, null, 2));
console.log(`us/trade=${((orderbook.elapsedMs / orderbook.trades) * 1000).toFixed(1)}`);
const afterOrderbook = snapshotOpCounters();
printOps('orderbook matcher ops', afterOrderbook, orderbook.trades);

const setupStarted = getPerfMs();
const { env, jurisdiction, hubId } = makeHubConsensusEnv('profile-1000-same');
const { same } = buildHubConsensusCases(env, jurisdiction, hubId, 1_000, 1_000, 1, false);
if (same.length !== 1 || same[0]!.txs.length !== 1_000) {
  throw new Error(`PROFILE_SAME_FRAME_SHAPE:${same.length}:${same[0]?.txs.length ?? 0}`);
}
const warmRootMs = (() => {
  const started = getPerfMs();
  computeAccountStateRoot(same[0]!.proposer.state);
  computeAccountStateRoot(same[0]!.receiver.state);
  return Number((getPerfMs() - started).toFixed(3));
})();
console.log(`\n== setup same-j 1000-tx frame ==`);
console.log(`setupMs=${(getPerfMs() - setupStarted).toFixed(1)}  warmRootMs=${warmRootMs}  offers=${same[0]!.proposer.state.swapOffers.size}`);
const afterSetup = snapshotOpCounters();
printOps('setup (identity+offers, not the frame)', diffOpCounters(afterOrderbook), 1_000);

proposalProfiles.length = 0;
const samplingStarted = await startRuntimeSamplingProfiler('frame-1000');
console.log(`sampling.started=${samplingStarted}`);

const hub = await runHubConsensusMeasuredCases(same, 1);
console.log('\n== hub Account consensus: 1 user, 1000 swap_resolve txs, one frame, same-j only ==');
console.log(JSON.stringify({
  elapsedMs: hub.elapsedMs,
  swaps: hub.swaps,
  tps: Number((hub.swaps / Math.max(hub.elapsedMs / 1000, 0.001)).toFixed(2)),
  usPerSwap: Number(((hub.elapsedMs / hub.swaps) * 1000).toFixed(1)),
  phaseTotalsMs: hub.phaseTotals,
  phaseUsPerSwap: Object.fromEntries(
    Object.entries(hub.phaseTotals).map(([phase, ms]) => [phase, Number(((ms / hub.swaps) * 1000).toFixed(1))]),
  ),
}, null, 2));
printOps('1000-tx Account consensus delta', diffOpCounters(afterSetup), hub.swaps);

console.log('\n== proposal.profile (one line per proposed frame) ==');
console.log(JSON.stringify(proposalProfiles, null, 2));
writeFileSync(`${OUT}/proposal-profile.json`, JSON.stringify(proposalProfiles, null, 2));

printSites('canonical.encode');
printSites('keccak.ethers');
printSites('keccak.text');
printSites('structuredClone');
printSites('ecdsa.sign');
dumpOpCounters('frame-1000', 'done');
dumpRuntimeSamplingProfile('done');

const samplePath = `${OUT}/samples/frame-1000-1.samples.json`;
try {
  const lines = summarizeSamples(samplePath);
  console.log('\n== sampling stacks ==');
  console.log(lines.join('\n'));
  writeFileSync(`${OUT}/sampling-top.txt`, lines.join('\n') + '\n');
} catch (error) {
  console.log(`sampling dump missing: ${error instanceof Error ? error.message : String(error)}`);
}
