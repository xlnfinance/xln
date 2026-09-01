import { describe, expect, test } from 'bun:test';

import type { AccountEnvelopeUpdate } from '../../../account/envelope/entity-update';
import { applyEntityAccountEnvelopeUpdate } from '../../../entity/account-envelope-update';
import type { AccountAuthorityEntityStageCapability } from '../../../entity/runtime-context';
import { getEntityAccountForWrite } from '../../../entity/state/persistent-account-map';
import type { EntityState } from '../../../entity/types';
import { createEmptyEnv } from '../../../runtime';
import { TsAccountWorkerAuthority } from '../../../rscore/ts-worker';
import { createJReplica } from '../../../scenarios/harness/boot';
import type { AccountReplica, AccountTx } from '../../../types/account';
import {
  entity,
  makeAccount,
  makeJurisdiction,
  makeState,
  openWritableEntityAccounts,
} from '../../helpers/cross-j';

/**
 * A dispute freeze is destructive and must fire exactly once per status change.
 *
 * `replaceDisputeLifecycle` also carries metadata-only updates — the finalize
 * latch, a counter-dispute, a hash recovery — that arrive while an Account is
 * already `dispute_preparing` or `disputed`. Freezing again on those would
 * silently erase queue rows admitted after the first freeze, which for a
 * disputed Account is the transformer evidence its own case rests on. Rust
 * returns early when the status is unchanged
 * (`rscore/crates/engine/src/consensus/replica.rs`), so TS must too.
 *
 * The queued transaction below is deliberately one a freeze would drop: it is
 * neither a deferred J claim nor optional dispute evidence, so its survival is
 * proof that no second freeze ran. Both engines must also agree, so every case
 * pins the inline root against one and four Account workers.
 */

const OWNER = entity('11');
const COUNTERPARTY = entity('22');
const SIGNER = `0x${'44'.repeat(20)}`;
const JURISDICTION = makeJurisdiction('worker-freeze-evidence', 31_337, '55', '66');

/** Dropped by `freezeAccountForDispute` under either retention policy. */
const QUEUED_AFTER_FREEZE: AccountTx = {
  type: 'set_credit_limit',
  data: { tokenId: 1, amount: 5n },
};

const activeDisputeShell = (): NonNullable<AccountReplica['activeDispute']> => ({
  startedByLeft: true,
  disputeTimeout: 4_102_500_000,
  disputeStartTimestamp: 4_102_400_000,
  initialProofbodyHash: `0x${'ab'.repeat(32)}`,
  initialNonce: 1,
  initialProposerIsLeft: true,
  observedOnChain: true,
  finalizeQueued: false,
});

type Seed = Readonly<{ status: AccountReplica['status']; disputed: boolean }>;

const buildEntityState = (seed: Seed): EntityState => {
  const state = makeState(OWNER, SIGNER, JURISDICTION);
  const account = makeAccount(OWNER, COUNTERPARTY, JURISDICTION);
  // The freeze that belongs to this status already happened; the row below is
  // what the Account queued afterwards.
  account.status = seed.status;
  if (seed.disputed) account.activeDispute = activeDisputeShell();
  else {
    account.disputePrepare = {
      startedAt: Number(state.timestamp ?? 0),
      readyAfter: Number(state.timestamp ?? 0),
      reason: 'worker-freeze-evidence',
    };
  }
  account.mempool = [QUEUED_AFTER_FREEZE];
  openWritableEntityAccounts(state).set(COUNTERPARTY, account);
  return state;
};

const metadataOnlyUpdate = (account: AccountReplica): AccountEnvelopeUpdate => ({
  type: 'replaceDisputeLifecycle',
  status: account.status,
  ...(account.disputePrepare === undefined ? {} : { disputePrepare: account.disputePrepare }),
  ...(account.activeDispute === undefined
    ? {}
    : { activeDispute: { ...account.activeDispute, finalizeQueued: true } }),
});

const runFrame = async (
  workers: number,
  seed: Seed,
): Promise<Readonly<{ root: string; mempool: readonly AccountTx[] }>> => {
  const state = buildEntityState(seed);
  const env = createEmptyEnv(`ts-worker-freeze-evidence-${workers}-${seed.status}`);
  const jReplica = createJReplica(env, JURISDICTION.name, JURISDICTION.depositoryAddress);
  jReplica.chainId = JURISDICTION.chainId;
  const write = (): void => {
    const account = getEntityAccountForWrite(state.accounts, COUNTERPARTY);
    if (!account) throw new Error('FREEZE_EVIDENCE_ACCOUNT_MISSING');
    applyEntityAccountEnvelopeUpdate(env, COUNTERPARTY, account, metadataOnlyUpdate(account));
  };
  const read = (): Readonly<{ root: string; mempool: readonly AccountTx[] }> => ({
    root: state.accounts.rootHash(),
    mempool: state.accounts.get(COUNTERPARTY)?.mempool ?? [],
  });
  if (workers === 0) {
    write();
    return read();
  }
  const authority = new TsAccountWorkerAuthority(env, workers);
  const envelopeUpdates: Array<Readonly<{ accountId: string; update: AccountEnvelopeUpdate }>> = [];
  try {
    const common = {
      ownerEntityId: OWNER,
      unsupportedEntityTxTypes: ['entityCommand'] as const,
      occurrence: { kind: 'runtime-input' as const, inputIndex: 0 },
      deferProposal: false,
    };
    await authority.provider.executeAccountInboundBatch({
      ...common,
      expectedAccountsRoot: state.accounts.rootHash(),
      entityState: state,
      entityContext: undefined,
      requests: [],
    });
    env.accountAuthorityEntityStage = {
      recordAccountEnvelopeUpdate: (accountId, update) => {
        envelopeUpdates.push({ accountId, update });
      },
    } as AccountAuthorityEntityStageCapability;
    write();
    delete env.accountAuthorityEntityStage;
    await authority.provider.executeAccountOutboundBatch({
      ...common,
      entityState: state,
      entityHeight: state.height + 1,
      accountForWrite: accountId => getEntityAccountForWrite(state.accounts, accountId),
      admissions: [],
      proposals: [],
      envelopeUpdates,
      materializeAccountIds: [],
    });
    return read();
  } finally {
    delete env.accountAuthorityEntityStage;
    await authority.close();
  }
};

describe('a metadata-only dispute lifecycle update never re-freezes the Account', () => {
  for (const [name, seed] of [
    ['between prepareDispute and disputeStart', { status: 'dispute_preparing', disputed: false }],
    ['before disputeFinalize', { status: 'disputed', disputed: true }],
  ] as const) {
    test(`${name}: the queued row survives and W0/W1/W4 agree`, async () => {
      const inline = await runFrame(0, seed);
      expect(inline.mempool).toEqual([QUEUED_AFTER_FREEZE]);
      for (const workers of [1, 4]) {
        const observed = await runFrame(workers, seed);
        expect(observed.mempool).toEqual([QUEUED_AFTER_FREEZE]);
        expect(observed.root).toBe(inline.root);
      }
    });
  }
});
