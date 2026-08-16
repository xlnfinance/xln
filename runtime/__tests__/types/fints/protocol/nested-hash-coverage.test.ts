import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { computeAccountStateRoot, encodeAccountStateValue } from '../../../../account/commitment/state-root';
import { createEmptyAccountJClaimAccumulator } from '../../../../account/j-claims/j-claim-accumulator';
import { createDefaultDelta } from '../../../../account/state/delta';
import { computeCanonicalEntityConsensusStateHash } from '../../../../entity/consensus/state-root';
import { HASHABLE_LOCK_BOOK_ENTRY_FIELDS } from '../../../../entity/state/lock-book-fields';
import { BATCH_ABI, PROOF_BODY_ABI } from '../../../../protocol/dispute/proof-body';
import type { AccountState, Delta, HtlcLock, HtlcRoute, SettlementWorkspace } from '../../../../types/account';
import type { EntityState } from '../../../../entity/types';
import {
  HASHABLE_DELTA_FIELDS,
  HASHABLE_HTLC_LOCK_FIELDS,
  HASHABLE_HTLC_ROUTE_FIELDS,
  HASHABLE_SETTLEMENT_WORKSPACE_FIELDS,
} from '../../../../types/hash-coverage/account-nested';
import { NESTED_HASH_COVERAGE } from '../../../../types/hash-coverage/catalog';
import {
  HASHABLE_RUNTIME_PAYMENT_FIELDS,
  HASHABLE_RUNTIME_PROOF_BODY_FIELDS,
  HASHABLE_RUNTIME_PULL_FIELDS,
  HASHABLE_RUNTIME_SWAP_FIELDS,
} from '../../../../types/hash-coverage/evidence-nested';

const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;
const HEX32 = (byte: string): string => `0x${byte.repeat(32)}`;

const accountState = (): AccountState => ({
  leftEntity: LEFT,
  rightEntity: RIGHT,
  domain: { chainId: 31337, depositoryAddress: `0x${'33'.repeat(20)}` },
  watchSeed: HEX32('44'),
  deltas: new Map([[1, createDefaultDelta(1)]]),
  locks: new Map(),
  swapOffers: new Map(),
  jNonce: 0,
  disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  lastFinalizedJHeight: 0,
  leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
  rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
  requestedRebalance: new Map(),
  requestedRebalanceFeeState: new Map(),
});

const lock = (): HtlcLock => ({
  lockId: HEX32('51'),
  hashlock: HEX32('52'),
  timelock: 1_700_000_000_000n,
  revealBeforeHeight: 8,
  amount: 7n,
  tokenId: 1,
  senderIsLeft: true,
  createdHeight: 1,
  createdTimestamp: 1_000,
});

const workspace = (): SettlementWorkspace => ({
  workspaceHash: HEX32('61'),
  ops: [],
  lastModifiedByLeft: true,
  status: 'draft',
  revision: 1,
  createdAt: 10,
  lastUpdatedAt: 10,
  executorIsLeft: true,
});

const route = (): HtlcRoute => ({
  hashlock: HEX32('71'),
  createdTimestamp: 1_000,
});

const entityState = (htlcRoute: HtlcRoute): EntityState => ({
  entityId: LEFT,
  entityEncryptionPublicKey: HEX32('44'),
  height: 1,
  timestamp: 100,
  nonces: new Map(),
  proposals: new Map(),
  config: { mode: 'proposer-based', threshold: 1n, validators: ['1'], shares: { '1': 1n } },
  reserves: new Map(),
  accounts: new Map(),
  lastFinalizedJHeight: 0,
  certifiedBoardState: {
    stackKey: HEX32('01'),
    boardRegistryRoot: HEX32('02'),
    finalizedJHeight: 1,
    finalizedJBlockHash: HEX32('03'),
    eventHistoryRoot: HEX32('04'),
  },
  profile: { name: 'nested-hash', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map([[HEX32('71'), htlcRoute]]),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
});

const deltaMutators = {
  tokenId: (value: Delta) => { value.tokenId = 2; },
  collateral: (value: Delta) => { value.collateral = 1n; },
  ondelta: (value: Delta) => { value.ondelta = 1n; },
  offdelta: (value: Delta) => { value.offdelta = -1n; },
  leftCreditLimit: (value: Delta) => { value.leftCreditLimit = 1n; },
  rightCreditLimit: (value: Delta) => { value.rightCreditLimit = 1n; },
  leftAllowance: (value: Delta) => { value.leftAllowance = 1n; },
  rightAllowance: (value: Delta) => { value.rightAllowance = 1n; },
  leftHold: (value: Delta) => { value.leftHold = 1n; },
  rightHold: (value: Delta) => { value.rightHold = 1n; },
} as const satisfies Record<(typeof HASHABLE_DELTA_FIELDS)[number], (value: Delta) => void>;

const lockMutators = {
  lockId: (value: HtlcLock) => { value.lockId = HEX32('a1'); },
  hashlock: (value: HtlcLock) => { value.hashlock = HEX32('a2'); },
  timelock: (value: HtlcLock) => { value.timelock = 2n; },
  revealBeforeHeight: (value: HtlcLock) => { value.revealBeforeHeight = 9; },
  amount: (value: HtlcLock) => { value.amount = 8n; },
  tokenId: (value: HtlcLock) => { value.tokenId = 2; },
  senderIsLeft: (value: HtlcLock) => { value.senderIsLeft = false; },
  createdHeight: (value: HtlcLock) => { value.createdHeight = 2; },
  createdTimestamp: (value: HtlcLock) => { value.createdTimestamp = 2_000; },
  envelopeHash: (value: HtlcLock) => { value.envelopeHash = HEX32('a3'); },
} as const satisfies Record<(typeof HASHABLE_HTLC_LOCK_FIELDS)[number], (value: HtlcLock) => void>;

const abiNames = (components: readonly { name: string }[]): readonly string[] =>
  components.map(component => component.name);

describe('nested hash-reachable field coverage', () => {
  test('every Delta catalog field is committed by the Account state root', () => {
    const base = accountState();
    const root = computeAccountStateRoot(base);
    for (const field of HASHABLE_DELTA_FIELDS) {
      const changed = structuredClone(base);
      deltaMutators[field](changed.deltas.get(1)!);
      expect(computeAccountStateRoot(changed), field).not.toBe(root);
    }
  });

  test('every HtlcLock catalog field is committed by the Account state root', () => {
    const base = accountState();
    base.locks.set(lock().lockId, lock());
    const root = computeAccountStateRoot(base);
    for (const field of HASHABLE_HTLC_LOCK_FIELDS) {
      const changed = structuredClone(base);
      const current = changed.locks.get(lock().lockId)!;
      lockMutators[field](current);
      if (field === 'lockId') {
        changed.locks.delete(lock().lockId);
        changed.locks.set(current.lockId, current);
      }
      expect(computeAccountStateRoot(changed), field).not.toBe(root);
    }
  });

  test('SettlementWorkspace and HtlcRoute catalog fields change committed roots', () => {
    const base = accountState();
    const emptyRoot = computeAccountStateRoot(base);
    const withWorkspace = structuredClone(base);
    withWorkspace.settlementWorkspace = workspace();
    expect(computeAccountStateRoot(withWorkspace)).not.toBe(emptyRoot);
    withWorkspace.settlementWorkspace = {
      ...workspace(),
      memo: 'nested-hash',
      revision: 2,
      leftHanko: '0xleft',
    };
    expect(computeAccountStateRoot(withWorkspace)).not.toBe(emptyRoot);
    expect(HASHABLE_SETTLEMENT_WORKSPACE_FIELDS).toContain('memo');

    const routeRoot = computeCanonicalEntityConsensusStateHash(entityState(route()));
    const other = route();
    other.amount = 9n;
    expect(computeCanonicalEntityConsensusStateHash(entityState(other))).not.toBe(routeRoot);
    expect(HASHABLE_HTLC_ROUTE_FIELDS).toContain('amount');
    expect(HASHABLE_LOCK_BOOK_ENTRY_FIELDS).toContain('lockId');
  });

  test('an unclassified own-key on Delta changes Account RLP bytes', () => {
    const canonical = createDefaultDelta(1);
    const drifted = { ...canonical, unexpected: 1n };
    expect(encodeAccountStateValue(drifted)).not.toEqual(encodeAccountStateValue(canonical));
  });

  test('Solidity ABI field order matches the evidence catalogs', () => {
    expect([...HASHABLE_RUNTIME_PROOF_BODY_FIELDS]).toEqual(abiNames(PROOF_BODY_ABI.components));
    expect([...HASHABLE_RUNTIME_PAYMENT_FIELDS]).toEqual(abiNames(BATCH_ABI.components[0]!.components));
    expect([...HASHABLE_RUNTIME_SWAP_FIELDS]).toEqual(abiNames(BATCH_ABI.components[1]!.components));
    expect([...HASHABLE_RUNTIME_PULL_FIELDS]).toEqual(abiNames(BATCH_ABI.components[2]!.components));
  });
});

describe('nested hash coverage gate registration', () => {
  test('package script and check:src include the AST ratchet exactly once', () => {
    const repoRoot = resolve(import.meta.dir, '../../../../..');
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const script = 'bun runtime/scripts/checks/fints/check-nested-hash-coverage.ts';
    expect(packageJson.scripts['check:nested-hash-coverage']).toBe(script);
    expect(existsSync(join(repoRoot, 'runtime/scripts/checks/fints/check-nested-hash-coverage.ts'))).toBe(true);
    const srcHits = (packageJson.scripts['check:src'] ?? '').split('&&').map(part => part.trim())
      .filter(part => part === 'bun run check:nested-hash-coverage');
    expect(srcHits).toEqual(['bun run check:nested-hash-coverage']);
    expect(NESTED_HASH_COVERAGE.length).toBeGreaterThan(20);
  });
});
