import { describe, expect, test } from 'bun:test';

import type { AccountEnvelopeUpdate } from '../../../account/envelope/entity-update';
import { applyEntityAccountEnvelopeUpdate } from '../../../entity/account-envelope-update';
import type { AccountAuthorityEntityStageCapability } from '../../../entity/runtime-context';
import { getEntityAccountForWrite } from '../../../entity/state/persistent-account-map';
import { handleSetRebalancePolicyEntityTx } from '../../../entity/tx/handlers/account/lifecycle/admin';
import type { EntityState } from '../../../entity/types';
import { createEmptyEnv } from '../../../runtime';
import { TsAccountWorkerAuthority } from '../../../rscore/ts-worker';
import { createJReplica } from '../../../scenarios/harness/boot';
import {
  entity,
  makeAccount,
  makeJurisdiction,
  makeState,
  openWritableEntityAccounts,
} from '../../helpers/cross-j';

const OWNER = entity('11');
const COUNTERPARTY = entity('22');
const SIGNER = `0x${'44'.repeat(20)}`;
const JURISDICTION = makeJurisdiction('worker-envelope-update', 31_337, '55', '66');

const buildEntityState = (): EntityState => {
  const state = makeState(OWNER, SIGNER, JURISDICTION);
  openWritableEntityAccounts(state).set(
    COUNTERPARTY,
    makeAccount(OWNER, COUNTERPARTY, JURISDICTION),
  );
  return state;
};

type EntityWrite = (
  state: EntityState,
  env: ReturnType<typeof createEmptyEnv>,
) => void;

const rootAfter = async (workers: number, write: EntityWrite): Promise<string> => {
  const state = buildEntityState();
  const env = createEmptyEnv(`ts-worker-envelope-update-${workers}`);
  const jReplica = createJReplica(env, JURISDICTION.name, JURISDICTION.depositoryAddress);
  jReplica.chainId = JURISDICTION.chainId;
  if (workers === 0) {
    write(state, env);
    return state.accounts.rootHash();
  }

  const authority = new TsAccountWorkerAuthority(env, workers);
  const envelopeUpdates: Array<Readonly<{
    accountId: string;
    update: AccountEnvelopeUpdate;
  }>> = [];
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
    write(state, env);
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
    return state.accounts.rootHash();
  } finally {
    delete env.accountAuthorityEntityStage;
    await authority.close();
  }
};

const setRebalancePolicy: EntityWrite = (state, env) => {
  handleSetRebalancePolicyEntityTx(env, state, {
    type: 'setRebalancePolicy',
    data: {
      counterpartyEntityId: COUNTERPARTY,
      tokenId: 1,
      r2cRequestSoftLimit: 10n,
      hardLimit: 100n,
      maxAcceptableFee: 5n,
    },
  }, true);
};

const prepareAccountDispute: EntityWrite = (state, env) => {
  const account = getEntityAccountForWrite(state.accounts, COUNTERPARTY);
  if (!account) throw new Error('TEST_ACCOUNT_MISSING');
  applyEntityAccountEnvelopeUpdate(env, COUNTERPARTY, account, {
    type: 'replaceDisputeLifecycle',
    status: 'dispute_preparing',
    disputePrepare: {
      startedAt: Number(state.timestamp ?? 0),
      readyAfter: Number(state.timestamp ?? 0),
      reason: 'worker-envelope-update',
    },
  });
};

describe('Entity-owned Account envelope updates', () => {
  for (const [name, write] of [
    ['setRebalancePolicy', setRebalancePolicy],
    ['dispute preparation', prepareAccountDispute],
  ] as const) {
    test(`${name} has identical W0/W1/W4 roots`, async () => {
      const inline = await rootAfter(0, write);
      expect(await rootAfter(1, write)).toBe(inline);
      expect(await rootAfter(4, write)).toBe(inline);
    });
  }
});
