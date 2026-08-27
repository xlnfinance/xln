#!/usr/bin/env bun

/**
 * Print and assert fixture metrics. Never sums ingress+egress.
 * Never calls replay throughput live TPS.
 */

import { resolve } from 'node:path';

import { readHltHubRecording } from '../../hlt/replay/recording';

type Manifest = Readonly<{
  recordingPath: string;
  distinctActiveAccounts: number;
  submittedPayments: number;
  completedPayments: number;
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
  const coverage = artifact.authorityEvidence.economicOperations.coverage;
  const ops = artifact.authorityEvidence.economicOperations.operations;

  // Distinct active bilateral Account IDs (each is a hub-peer pair)
  const distinctAccounts = new Set(
    ops.flatMap(op => op.stages.map(stage => `${stage.ownerEntityId}|${stage.counterpartyId}`)),
  );

  // Submitted payments = all direct_payment account txs
  const submittedPayments = coverage.directPayments;

  // Completed payments = direct payments with at least one stage
  const completedPayments = ops
    .filter(op => op.kind === 'direct_payment' && op.stages.length > 0)
    .length;

  // Runtime frames
  const runtimeFrames = artifact.totals.runtimeFrames;

  // Every accepted bilateral round contains exactly one received AccountInput
  // and one emitted AccountInput. The oracle stores the committed frame once,
  // whether it committed from an ACK (`ackCommit`) or peer proposal
  // (`peerCommit`); retransmit traffic is intentionally outside this count.
  const accountRounds = artifact.authorityFrameOracle.accountFrames
    .filter(record => record.source === 'ackCommit' || record.source === 'peerCommit').length;
  const accountIngress = accountRounds;
  const accountEgress = accountRounds;

  // Batch distribution: number of direct_payment account txs per Runtime frame
  const batchSizes: number[] = [];
  const frameToPayments = new Map<number, number>();
  for (const record of artifact.authorityFrameOracle.accountFrames) {
    if (record.frame.accountTxs.some(tx => tx.type === 'direct_payment')) {
      const count = record.frame.accountTxs.filter(tx => tx.type === 'direct_payment').length;
      frameToPayments.set(
        record.runtimeHeight,
        (frameToPayments.get(record.runtimeHeight) ?? 0) + count,
      );
    }
  }
  for (const count of frameToPayments.values()) {
    batchSizes.push(count);
  }
  batchSizes.sort((a, b) => a - b);

  const manifest: Manifest = {
    recordingPath,
    distinctActiveAccounts: distinctAccounts.size,
    submittedPayments,
    completedPayments,
    runtimeFrames,
    accountIngress,
    accountEgress,
    batchSizes,
    batchP50: percentile(batchSizes, 50),
    batchP95: percentile(batchSizes, 95),
    batchMax: batchSizes.length > 0 ? batchSizes.at(-1)! : 0,
    outboxEnvelopes: artifact.totals.outboxEnvelopes,
    swaps: coverage.swapResolves,
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
  if (manifest.completedPayments < manifest.submittedPayments * 0.5) {
    throw new Error(
      `FIXTURE_MANIFEST_ASSERT_COMPLETED_PAYMENTS:` +
      `submitted=${manifest.submittedPayments}:completed=${manifest.completedPayments}`,
    );
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
  lines.push(` completedPayments      ${manifest.completedPayments}`);
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
