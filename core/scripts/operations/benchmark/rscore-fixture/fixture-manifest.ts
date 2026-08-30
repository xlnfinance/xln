#!/usr/bin/env bun

/**
 * Print and assert fixture metrics. Never sums ingress+egress.
 * Never calls replay throughput live TPS.
 */

import { resolve } from 'node:path';

import type { EntityTx } from '../../../../types/entity-tx';
import { readHltHubRecording, recordingFrames } from '../../hlt/replay/recording';

type Manifest = Readonly<{
  recordingPath: string;
  distinctActiveAccounts: number;
  submittedPayments: number;
  runtimeFrames: number;
  accountIngress: number;
  accountEgress: number;
  batchSizes: readonly number[];
  batchP50: number;
  batchP95: number;
  batchMax: number;
  outboxEnvelopes: number;
  swaps: number;
}>;

const visitEntityTx = (tx: EntityTx, visit: (tx: EntityTx) => void): void => {
  visit(tx);
  if (tx.type === 'entityCommand') {
    for (const nested of tx.data.txs) visitEntityTx(nested, visit);
  } else if (tx.type === 'runtimeOutput') {
    for (const nested of tx.data.entityTxs) visitEntityTx(nested, visit);
  }
};

const bilateralKey = (left: string, right: string): string => {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a < b ? `${a}|${b}` : `${b}|${a}`;
};

const percentile = (sorted: number[], pct: number): number => {
  if (sorted.length === 0) return 0;
  const rank = pct / 100 * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const fraction = rank - lo;
  return sorted[lo]! * (1 - fraction) + sorted[hi]! * fraction;
};

export const analyzeFixture = (recordingPath: string): Manifest => {
  const artifact = readHltHubRecording(recordingPath);
  const frames = recordingFrames(artifact.recording);
  const distinctAccounts = new Set<string>();
  let submittedPayments = 0;
  let accountIngress = 0;
  let accountEgress = 0;
  let swaps = 0;
  const batchSizes: number[] = [];

  for (const frame of frames) {
    let framePayments = 0;
    for (const input of frame.runtimeInput.entityInputs) {
      for (const tx of [...(input.entityTxs ?? []), ...(input.proposedFrame?.txs ?? [])]) {
        visitEntityTx(tx, current => {
          if (current.type === 'directPayment') {
            submittedPayments += 1;
            framePayments += 1;
            for (let index = 1; index < current.data.route.length; index += 1) {
              distinctAccounts.add(bilateralKey(
                current.data.route[index - 1]!,
                current.data.route[index]!,
              ));
            }
          } else if (current.type === 'accountInput') {
            accountIngress += 1;
            distinctAccounts.add(bilateralKey(
              current.data.fromEntityId,
              current.data.toEntityId,
            ));
          }
        });
      }
    }
    for (const output of frame.runtimeOutputs ?? []) {
      for (const tx of output.entityTxs ?? []) {
        visitEntityTx(tx, current => {
          if (current.type === 'accountInput') accountEgress += 1;
        });
      }
    }
    swaps += frame.logs.filter(entry => entry.message === 'SwapMatched').length;
    if (framePayments > 0) batchSizes.push(framePayments);
  }
  const sortedBatchSizes = batchSizes.toSorted((a, b) => a - b);

  const manifest: Manifest = {
    recordingPath,
    distinctActiveAccounts: distinctAccounts.size,
    submittedPayments,
    runtimeFrames: frames.length,
    accountIngress,
    accountEgress,
    batchSizes,
    batchP50: percentile(sortedBatchSizes, 50),
    batchP95: percentile(sortedBatchSizes, 95),
    batchMax: sortedBatchSizes.at(-1) ?? 0,
    outboxEnvelopes: artifact.totals.outboxEnvelopes,
    swaps,
  };

  return manifest;
};

export const assertManifest = (manifest: Manifest): void => {
  if (manifest.distinctActiveAccounts < 1) {
    throw new Error(`FIXTURE_MANIFEST_ASSERT_DISTINCT_ACTIVE_ACCOUNTS:${manifest.distinctActiveAccounts}`);
  }
  if (manifest.submittedPayments < 1) {
    throw new Error(`FIXTURE_MANIFEST_ASSERT_SUBMITTED_PAYMENTS:${manifest.submittedPayments}`);
  }
  if (manifest.runtimeFrames < 1) {
    throw new Error(`FIXTURE_MANIFEST_ASSERT_RUNTIME_FRAMES:${manifest.runtimeFrames}`);
  }
};

export const printManifest = (manifest: Manifest): string => {
  const lines: string[] = [];
  lines.push('========================================');
  lines.push(' FIXTURE MANIFEST');
  lines.push('========================================');
  lines.push(` recordingPath          ${manifest.recordingPath}`);
  lines.push(` distinctActiveAccounts  ${manifest.distinctActiveAccounts}`);
  lines.push(` submittedPayments      ${manifest.submittedPayments}`);
  lines.push(` runtimeFrames           ${manifest.runtimeFrames}`);
  lines.push(` accountIngress          ${manifest.accountIngress}`);
  lines.push(` accountEgress           ${manifest.accountEgress}`);
  lines.push('----------------------------------------');
  lines.push(` batchDistribution       p50=${manifest.batchP50.toFixed(1)} p95=${manifest.batchP95.toFixed(1)} max=${manifest.batchMax}`);
  lines.push(` batches                 ${manifest.batchSizes.length}`);
  lines.push(` outboxEnvelopes         ${manifest.outboxEnvelopes}`);
  lines.push(` swaps                   ${manifest.swaps}`);
  lines.push('========================================');
  return lines.join('\n');
};

// -- CLI
if (import.meta.main) {
  const paths = process.argv.slice(2).filter(arg => !arg.startsWith('-'));
  if (paths.length === 0) {
    console.error('Usage: bun fixture-manifest.ts <recording.json> [recording2.json ...]');
    process.exit(1);
  }
  let exitCode = 0;
  for (const rawPath of paths) {
    const recordingPath = resolve(rawPath);
    try {
      const manifest = analyzeFixture(recordingPath);
      assertManifest(manifest);
      console.log(printManifest(manifest));
    } catch (error) {
      console.error(`FIXTURE_MANIFEST_ERROR path=${recordingPath}: ${String(error)}`);
      exitCode = 1;
    }
  }
  process.exit(exitCode);
}
