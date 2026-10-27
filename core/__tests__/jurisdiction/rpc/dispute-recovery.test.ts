import { expect, test } from 'bun:test';
import { rebuildWatcherDisputeReferences } from '../../../jurisdiction/adapter/rpc/watcher/rpc-watcher-reference-recovery';
import { emptyDisputeReferences } from '../../../jurisdiction/adapter/events/dispute/reference-state';
import { decodeAuthenticatedWatcherEvents } from '../../../jurisdiction/adapter/rpc-watcher-events';
import { createEntityProposalFixture } from '../../helpers/entity-proposal-fixture';
import { createTestJReplica } from '../../helpers/j-replica';
import { createJurisdictionConfig } from '../../../scenarios/harness/boot';
import type { AuthenticatedReceiptRange } from '../../../jurisdiction/adapter/receipt-root';
import { ethers } from 'ethers';

const hash = (height: number) => ethers.zeroPadValue(ethers.toBeHex(height), 32);

test('crash recovery reads (shared cursor, Entity anchor], binds its tip, and never redelivers the start', async () => {
  const fixture = await Bun.file('core/__tests__/fixtures/jurisdiction/dispute-emitted-logs.json').json();
  const { env, replica } = createEntityProposalFixture('reference-recovery', 1n, ['1']).createValidator('1');
  const started = fixture.logs[0];
  // Retain real contract bytes and pair identity from the receipt fixture.
  replica.entityId = started.topics[1]; replica.state.entityId = started.topics[1];
  replica.state.lastFinalizedJHeight = 42;
  env.state.eReplicas.set(`${replica.entityId}:${replica.signerId}`, replica);
  const watcherReplica = createTestJReplica({ name: 'disputes', chainId: 31337,
    blockNumber: 41n, entityProviderDeploymentBlock: 40,
    contracts: { depository: started.address, entityProvider: `0x${'bb'.repeat(20)}` } });
  replica.state.config.jurisdiction = createJurisdictionConfig(watcherReplica.name,
    started.address, watcherReplica.contracts!.entityProvider!, 'http://127.0.0.1:8545', 31337);
  const ranges: number[][] = [];
  const readRange = async (from: number, to: number): Promise<AuthenticatedReceiptRange> => {
    ranges.push([from, to]);
    return { anchor: { jHeight: 41, jBlockHash: hash(41), parentHash: hash(40) },
      headers: [{ jHeight: 42, jBlockHash: hash(42), parentHash: hash(41) }], tipStateRoot: null,
      logs: [{ ...started, blockNumber: 42, blockHash: hash(42), index: 0 }] };
  };
  const request = { env, watcherReplica, fromBlock: 42, toBlock: 42, tipBlockHash: hash(42), targetFinalized: true,
    references: emptyDisputeReferences(), readRange };
  const references = await rebuildWatcherDisputeReferences(request);
  if (!references) throw new Error('RECOVERY_CANCELLED');
  expect(ranges).toEqual([[42, 42]]);
  expect(Object.values(references.startBlocks)).toEqual([42]);
  const decoded = await decodeAuthenticatedWatcherEvents({ env, watcherReplica, disputeReferences: references,
    logs: [{ ...fixture.logs[1], blockNumber: 43, blockHash: hash(43), index: 0 }],
    depositoryAddress: started.address, entityProviderAddress: watcherReplica.contracts!.entityProvider!,
    tokenByAddress: new Map(), trackedOwners: new Map(), observedThroughHeight: 43,
    observedTipBlockHash: hash(43), observedHeadHeight: 43, confirmationDepth: 0,
    readDisputeReferenceLogs: async () => { throw new Error('NO_HISTORY_READ_AFTER_RECOVERY'); },
  });
  expect(decoded.events.map(event => event.name)).toEqual(['DisputeFinalized']);
  await expect(rebuildWatcherDisputeReferences({ ...request, tipBlockHash: hash(99) })).rejects.toThrow('ANCHOR_MISMATCH');
  expect(request.references).toEqual(emptyDisputeReferences());
});

test('unfinalized target and intermediate page races retry; certified target mismatch stays fatal', async () => {
  const { env } = createEntityProposalFixture('reference-page-race', 1n, ['1']).createValidator('1');
  const watcherReplica = createTestJReplica({ name: 'pages', chainId: 31337, blockNumber: 0n });
  let changedPage = false;
  let reads = 0;
  const request = {
    env, watcherReplica, references: emptyDisputeReferences(), fromBlock: 1, toBlock: 257,
    tipBlockHash: hash(999), targetFinalized: false,
    readRange: async (from: number, to: number): Promise<AuthenticatedReceiptRange> => {
      reads += 1;
      return { anchor: { jHeight: from - 1, jBlockHash: hash(changedPage && from === 257 ? 998 : from - 1),
        parentHash: hash(Math.max(0, from - 2)) },
        headers: Array.from({ length: to - from + 1 }, (_, i) => ({
          jHeight: from + i, jBlockHash: hash(from + i), parentHash: hash(from + i - 1),
        })), tipStateRoot: null, logs: [] };
    },
  };
  await expect(rebuildWatcherDisputeReferences(request)).rejects.toThrow('J_RECEIPT_RANGE_REORG');
  await expect(rebuildWatcherDisputeReferences({ ...request, targetFinalized: true }))
    .rejects.toThrow('J_DISPUTE_REFERENCE_ANCHOR_MISMATCH');
  changedPage = true;
  await expect(rebuildWatcherDisputeReferences({ ...request, targetFinalized: true }))
    .rejects.toThrow('J_RECEIPT_RANGE_REORG');
  expect(request.references).toEqual(emptyDisputeReferences());
  reads = 0;
  expect(await rebuildWatcherDisputeReferences({ ...request, isCancelled: () => reads === 1 })).toBeNull();
  expect(reads).toBe(1);
});
