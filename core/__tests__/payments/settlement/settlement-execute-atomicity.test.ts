import { expect, test } from 'bun:test';

import { withReadySettlement } from '../../../../rscore/fixtures/entity-resident-group-e/group-e';
import { executeFrame } from '../../../../rscore/fixtures/entity-resident-group-e/runtime-vector';
import { advanceEntityCommandNonce, buildSignedEntityCommand } from '../../../entity/command';
import { signedEntityCommandTx } from '../../../entity/command/command-codec';
import { buildCollectiveEntityProposalTx } from '../../../entity/auth/authorization';
import { computeCanonicalEntityConsensusStateHash } from '../../../entity/consensus/state-root';
import { createEntityFrameCandidateState } from '../../../entity/state-clone';
import { getEntityAccountForWrite } from '../../../entity/state/persistent-account-map';
import { handleSettleExecute } from '../../../entity/tx/handlers/payments/settle';

test('initially ready settle_execute is idempotent within one and across two signed outer commands', async () => {
  await withReadySettlement(async (sameLeft, sameRight) => {
    await withReadySettlement(async (separateLeft, separateRight) => {
      for (const [separate, left, right] of [
        [false, sameLeft, sameRight],
        [true, separateLeft, separateRight],
      ] as const) {
        const replica = () => [...left.env.state.eReplicas.values()].find(row => row.entityId === left.entityId)!;
        const before = replica().state;
        const beforeNonce = before.entityCommandNonces?.bySigner.get(left.signerId)?.nonce ?? 0n;
        const root = computeCanonicalEntityConsensusStateHash(before);
        const account = before.accounts.get(right.entityId)!;
        expect(account.state.settlementWorkspace?.status).toBe('ready_to_submit');
        expect(account.pendingFrame).toBeUndefined();
        expect(account.mempool).toHaveLength(0);
        const tx = {
          type: 'settle_execute' as const,
          data: { counterpartyEntityId: right.entityId, disableC2RShortcut: true },
        };
        const first = buildSignedEntityCommand(left.env, before, left.signerId, [
          buildCollectiveEntityProposalTx(left.signerId, separate ? [tx] : [tx, tx]),
        ]);
        const commands = [signedEntityCommandTx(first)];
        if (separate) {
          const cursor = advanceEntityCommandNonce(before, first);
          commands.push(
            signedEntityCommandTx(
              buildSignedEntityCommand(left.env, cursor, left.signerId, [
                buildCollectiveEntityProposalTx(left.signerId, [tx]),
              ]),
            ),
          );
        }
        const result = await executeFrame(left.env, [
          { entityId: left.entityId, signerId: left.signerId, entityTxs: commands },
        ]);
        expect(result.projection.canonicalEntityInputs).toHaveLength(1);
        expect(result.projection.canonicalEntityInputs[0]!.entityTxs).toHaveLength(separate ? 2 : 1);
        expect(result.outputs).toHaveLength(1);
        expect(replica().state.entityCommandNonces?.bySigner.get(left.signerId)?.nonce).toBe(
          beforeNonce + (separate ? 2n : 1n),
        );
        expect(result.projection.entityFrames).toHaveLength(1);
        expect(result.projection.entityFrames[0]!.txs).toHaveLength(separate ? 2 : 1);
        expect(replica().state.jBatchState?.batch.settlements).toHaveLength(1);
        expect(
          replica()
            .state.accounts.get(right.entityId)
            ?.pendingFrame?.accountTxs.filter(tx => tx.type === 'settle_transition' && tx.data.kind === 'submit'),
        ).toHaveLength(1);
        expect(replica().state.accounts.get(right.entityId)?.mempool).toHaveLength(0);
        const queuedEvents = result.projection.entityFrames[0]!.events.filter(
          event => event.type === 'status' && event.message.startsWith('✅ Settlement submission queued'),
        );
        expect(queuedEvents).toHaveLength(2);
        expect(computeCanonicalEntityConsensusStateHash(replica().state)).not.toBe(root);
      }
    });
  });
});

test('settle_execute skips a counterparty Hanko that no longer verifies, never a halt', async () => {
  // The counterparty can rotate its board after signing; its settlement Hanko
  // then fails the current-board check and settle_execute used to throw a
  // plain Error. The hub scheduler re-emits it every tick: a halt on restart.
  await withReadySettlement(async (left, right) => {
    const committed = [...left.env.state.eReplicas.values()].find(row => row.entityId === left.entityId)!.state;
    const tx = {
      type: 'settle_execute' as const,
      data: { counterpartyEntityId: right.entityId, disableC2RShortcut: true },
    };
    const live = await handleSettleExecute(createEntityFrameCandidateState(committed), tx, left.env);
    expect(live.newState.jBatchState?.batch.settlements).toHaveLength(1);

    const retired = createEntityFrameCandidateState(committed);
    const account = getEntityAccountForWrite(retired.accounts, right.entityId)!;
    const workspace = account.state.settlementWorkspace!;
    // A genuine Hanko by the same counterparty, over a hash it no longer authorizes.
    account.state = {
      ...account.state,
      settlementWorkspace: { ...workspace, rightHanko: workspace.postSettlementDisputeProof!.rightHanko! },
    };
    const skipped = await handleSettleExecute(retired, tx, left.env);
    expect(skipped.newState.jBatchState?.batch.settlements ?? []).toHaveLength(0);
    expect(skipped.accountTxs).toHaveLength(0);
  });
});
