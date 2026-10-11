import { expect, test } from 'bun:test';
import { accountInputAck, accountInputProposal } from '../../../account/consensus/flush';
import { requireAccountDeltaTransformerAddress } from '../../../account/consensus/helpers';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { getEntityAccountForWrite } from '../../../entity/state/persistent-account-map';
import { resolveInboundAccount } from '../../../entity/tx/handlers/account/inbound-account';
import { runAccountAuthorityEntityStage } from '../../../rscore/authority/entity-stage';
import { TsAccountWorkerAuthority } from '../../../rscore/ts-worker';
import { createEmptyEnv } from '../../../runtime';
import { createJReplica } from '../../../scenarios/harness/boot';
import { addr, entity, makeJurisdiction, makeState } from '../../helpers/cross-j';

test('resident proposal selection does not claim an unchanged Account for writing', async () => {
  const env = createEmptyEnv('account-authority-readonly-selection');
  const owner = entity('11'),
    peer = entity('22'),
    signerId = addr('33');
  const jurisdiction = makeJurisdiction('readonly-selection', 31337, '44', '55');
  const j = createJReplica(env, jurisdiction.name, jurisdiction.depositoryAddress);
  j.chainId = jurisdiction.chainId;
  j.contracts = {
    ...j.contracts,
    depository: jurisdiction.depositoryAddress,
    entityProvider: jurisdiction.entityProviderAddress,
    account: addr('66'),
    deltaTransformer: addr('77'),
  };
  const state = makeState(owner, signerId, jurisdiction, peer);
  const before = state.accounts.get(peer);
  if (!before) throw new Error('READONLY_SELECTION_ACCOUNT_MISSING');
  const rootBefore = state.accounts.rootHash();
  const context = createAccountConsensusContext(env);
  const authority = new TsAccountWorkerAuthority(env, 1);
  let claims = 0;
  const accountForWrite = (id: string) => {
    claims += 1;
    return getEntityAccountForWrite(state.accounts, id);
  };
  try {
    await runAccountAuthorityEntityStage(
      env,
      {
        ownerEntityId: owner,
        ownerSignerId: signerId,
        provider: authority.provider,
        occurrence: { kind: 'runtime-input', inputIndex: 0 },
        deferProposal: false,
      },
      async () => {
        const stage = env.accountAuthorityEntityStage;
        if (!stage) throw new Error('READONLY_SELECTION_STAGE_MISSING');
        await stage.beginEntityAccountFrame({
          ownerEntityId: owner,
          expectedAccountsRoot: rootBefore,
          entityState: state,
          entityContext: {
            version: 1,
            entityId: owner,
            proposerSignerId: signerId,
            proposerReplicaId: `${owner}:${signerId}`,
            parentFrameHash: state.prevFrameHash,
            height: 1,
            gossipProfiles: [],
            peerAssertions: [],
            htlc: { version: 1, entries: [], originated: [] },
          },
          entityTxs: [],
          accounts: state.accounts,
          accountForWrite,
          createInboundAccount: input => {
            const resolution = resolveInboundAccount(
              state,
              input,
              Boolean(accountInputAck(input)),
              Boolean(accountInputProposal(input)),
            );
            return {
              account: resolution.account,
              deltaTransformer: requireAccountDeltaTransformerAddress(context, resolution.account.state),
            };
          },
          entityTimestamp: state.timestamp,
          finalizedJHeight: 0,
        });
        await stage.executeEntityBooks({ entityState: state, slots: [] });
        await stage.prepareEntityAccountOutbound({
          entityState: state,
          entityHeight: 1,
          accounts: state.accounts,
          accountForWrite,
          proposalAccountIds: [peer],
          timestamp: state.timestamp,
          jHeight: 0,
        });
      },
    );
    expect(state.accounts.rootHash()).toBe(rootBefore);
    expect(claims).toBe(0);
    expect(state.accounts.get(peer)).toBe(before);
    expect(before.mempool).toHaveLength(0);
    expect(before.pendingFrame).toBeUndefined();
  } finally {
    await authority.close();
  }
});
