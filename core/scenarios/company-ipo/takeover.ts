/**
 * Settles purchased CONTROL into the investor Entity reserve, then exercises
 * the reserve-majority board proposal and permissionless activation paths.
 */

import type { ConsensusConfig } from '../../entity/types';
import { deriveDelta } from '../../account/utils';
import { encodeBoard, hashBoard } from '../../entity/factory';
import { zeroPadValue } from 'ethers';
import type { RuntimeReplica } from '../../runtime/types';
import { isBatchEmpty } from '../../jurisdiction/machine/batch';
import { maybeApproveSettlement } from '../consensus/ahb-helpers';
import { requireReplica } from '../consensus/multi-sig';
import {
  advanceScenarioPastDisputeTimeout,
  converge,
  findReplica,
  processWithOffline,
  syncChain,
} from '../harness/helpers';
import { executeCompanyAction } from './governance';
import type { CompanyScenarioActors, CompanyShareTokens } from './model';
import { CONTROL_IPO_AMOUNT } from './model';

const executeSettlement = async (
  env: RuntimeReplica,
  proposer: CompanyScenarioActors['hub'],
  counterparty: CompanyScenarioActors['hub'],
  ops: Extract<import('../../types/entity-tx').EntityTx, { type: 'settle_propose' }>['data']['ops'],
  memo: string,
): Promise<void> => {
  await executeCompanyAction(env, proposer, [{
    type: 'settle_propose',
    data: { counterpartyEntityId: counterparty.id, ops, memo },
  }]);
  await converge(env, 30);
  const workspace = findReplica(env, proposer.id)[1]
    .state.accounts.get(counterparty.id)?.state.settlementWorkspace;
  if (!workspace) throw new Error(`COMPANY_SETTLEMENT_WORKSPACE_MISSING:${memo}`);
  if (workspace.status !== 'ready_to_submit') {
    const counterpartySigner = counterparty.validators[0];
    if (!counterpartySigner) throw new Error(`COMPANY_BOARD_VALIDATOR_MISSING:${counterparty.id}:0`);
    await maybeApproveSettlement(env, {
      id: counterparty.id,
      signer: counterpartySigner,
      name: counterparty.name,
    }, proposer.id);
  }
  await executeCompanyAction(env, proposer, [{
    type: 'settle_execute',
    data: { counterpartyEntityId: counterparty.id },
  }, { type: 'j_broadcast', data: {} }]);
  await syncChain(env, 12);
};

export const settleInvestorControlReserve = async (
  env: RuntimeReplica,
  actors: CompanyScenarioActors,
  shares: CompanyShareTokens,
): Promise<void> => {
  const companyAccount = findReplica(env, actors.hub.id)[1].state.accounts.get(actors.boardCompany.id);
  const companyDelta = companyAccount?.state.deltas.get(shares.controlTokenId);
  if (!companyAccount || !companyDelta) throw new Error('COMPANY_HUB_CONTROL_DELTA_MISSING');
  const hubControl = deriveDelta(
    companyDelta,
    companyAccount.state.leftEntity === actors.hub.id,
  );
  if (hubControl.outCapacity < CONTROL_IPO_AMOUNT) {
    throw new Error(
      `COMPANY_HUB_CONTROL_SETTLEMENT_CAPACITY:` +
      `out=${hubControl.outCapacity}:in=${hubControl.inCapacity}:delta=${hubControl.delta}:` +
      `collateral=${hubControl.collateral}:ownCredit=${hubControl.ownCreditLimit}:` +
      `peerCredit=${hubControl.peerCreditLimit}:required=${CONTROL_IPO_AMOUNT}`,
    );
  }
  await executeSettlement(env, actors.hub, actors.boardCompany, [{
    type: 'c2r',
    tokenId: shares.controlTokenId,
    amount: CONTROL_IPO_AMOUNT,
  }], 'company-control-to-hub-reserve');

  await executeSettlement(env, actors.hub, actors.investor, [{
    type: 'r2c',
    tokenId: shares.controlTokenId,
    amount: CONTROL_IPO_AMOUNT,
  }], 'hub-control-to-investor-collateral');
  await executeSettlement(env, actors.investor, actors.hub, [{
    type: 'c2r',
    tokenId: shares.controlTokenId,
    amount: CONTROL_IPO_AMOUNT,
  }], 'investor-control-collateral-to-reserve');

  const reserve = await actors.jadapter.getReserves(actors.investor.id, shares.controlTokenId);
  if (reserve !== CONTROL_IPO_AMOUNT) {
    throw new Error(`COMPANY_INVESTOR_CONTROL_RESERVE_MISMATCH:${reserve}:${CONTROL_IPO_AMOUNT}`);
  }
};

export const proposeInvestorBoard = async (
  env: RuntimeReplica,
  actors: CompanyScenarioActors,
): Promise<{ config: ConsensusConfig; boardHash: string }> => {
  const signer = actors.investor.validators[0];
  if (!signer) throw new Error('COMPANY_INVESTOR_SIGNER_MISSING');
  const config: ConsensusConfig = {
    ...actors.boardCompany.config,
    threshold: 1n,
    validators: [signer],
    shares: { [signer]: 1n },
  };
  const encodedBoard = encodeBoard(config, env);
  const boardHash = hashBoard(encodedBoard).toLowerCase();
  // proposeBoard accepts only committed (on-chain validated) preimages. The
  // proposer holds the board config, so it commits the preimage permissionlessly
  // before the CONTROL proposal carries the bare hash through Entity consensus.
  if (!(await actors.jadapter.entityProvider.committedBoards(boardHash))) {
    const commit = await actors.jadapter.entityProvider.commitBoard(encodedBoard);
    const commitReceipt = await commit.wait();
    if (commitReceipt?.status !== 1) throw new Error(`COMPANY_BOARD_COMMIT_FAILED:${boardHash}`);
  }
  const actionNonce = await actors.jadapter.entityProvider.boardActionNonces(actors.boardCompany.id) + 1n;
  await executeCompanyAction(env, actors.investor, [{
    type: 'entityProviderProposeControlBoard',
    data: {
      targetEntityId: actors.boardCompany.id,
      newBoardHash: boardHash,
      actionNonce,
    },
  }]);
  await syncChain(env, 15);
  const entity = await actors.jadapter.entityProvider.entities(actors.boardCompany.id);
  if (String(entity.proposedBoardHash).toLowerCase() !== boardHash) {
    throw new Error(`COMPANY_CONTROL_PROPOSAL_NOT_COMMITTED:${String(entity.proposedBoardHash)}:${boardHash}`);
  }
  return { config, boardHash };
};

/**
 * Governance delays are jurisdiction SECONDS: activateBoard requires
 * block.timestamp >= Entity.activateAt. Jump both the chain clock and the
 * runtime clock past that unix deadline (BrowserVM: next block timestamp;
 * RPC: evm_increaseTime + evm_mine).
 */
const advanceControlDelay = async (
  env: RuntimeReplica,
  actors: CompanyScenarioActors,
): Promise<void> => {
  const entity = await actors.jadapter.entityProvider.entities(actors.boardCompany.id);
  const activateAt = Number(entity.activateAt);
  if (!Number.isSafeInteger(activateAt) || activateAt <= 0) {
    throw new Error(`COMPANY_CONTROL_ACTIVATE_AT_INVALID:${String(entity.activateAt)}`);
  }
  await advanceScenarioPastDisputeTimeout(env, actors.jadapter, activateAt);
};

export const activateInvestorBoardAndHandover = async (
  env: RuntimeReplica,
  actors: CompanyScenarioActors,
  next: { config: ConsensusConfig; boardHash: string },
): Promise<void> => {
  await advanceControlDelay(env, actors);
  // Advancing the governance delay can move the jurisdiction head past the
  // durable watcher cursor. Catch up that history before activation, so the
  // next observed block is the exact BoardActivated transition.
  await syncChain(env, 20);
  const signer = next.config.validators[0];
  if (!signer) throw new Error('COMPANY_HANDOVER_SIGNER_MISSING');
  const before = requireReplica(env, actors.boardCompany.id, signer).state;
  await processWithOffline(env, [{
    entityId: actors.boardCompany.id,
    signerId: signer,
    entityTxs: [{
      type: 'boardHandover',
      data: {
        board: {
          mode: next.config.mode,
          threshold: next.config.threshold,
          validators: [...next.config.validators],
          shares: { ...next.config.shares },
        },
      },
    }],
  }], new Set());
  await executeCompanyAction(env, actors.investor, [{
    type: 'entityProviderActivateBoard',
    data: { targetEntityId: actors.boardCompany.id },
  }]);
  await syncChain(env, 20);
  await converge(env, 80);

  const committed = requireReplica(env, actors.boardCompany.id, signer).state;
  if (committed.height < before.height + 1) {
    throw new Error(`COMPANY_HANDOVER_HEIGHT_INVALID:${before.height}:${committed.height}`);
  }
  if (
    committed.config.threshold !== 1n ||
    committed.config.validators.length !== 1 ||
    committed.config.validators[0]?.toLowerCase() !== signer.toLowerCase() ||
    committed.leaderState?.activeValidatorId.toLowerCase() !== signer.toLowerCase() ||
    committed.leaderState.view !== 0
  ) {
    throw new Error('COMPANY_HANDOVER_AUTHORITY_NOT_INSTALLED');
  }
  if (
    committed.accounts.size !== before.accounts.size ||
    committed.reserves.size !== before.reserves.size ||
    committed.proposals.size !== before.proposals.size
  ) {
    throw new Error('COMPANY_HANDOVER_STATE_CONTINUITY_MISMATCH');
  }
  const record = await actors.jadapter.entityProvider.entities(actors.boardCompany.id);
  if (String(record.currentBoardHash).toLowerCase() !== next.boardHash) {
    throw new Error('COMPANY_HANDOVER_ONCHAIN_BOARD_MISMATCH');
  }
};

export const proveSuccessorReserveControl = async (
  env: RuntimeReplica,
  actors: CompanyScenarioActors,
  shares: CompanyShareTokens,
): Promise<void> => {
  const signer = actors.boardCompany.validators[0];
  if (!signer) throw new Error('COMPANY_SUCCESSOR_SIGNER_MISSING');
  const companyState = requireReplica(env, actors.boardCompany.id, signer).state;
  if (
    companyState.jBatchState &&
    (!isBatchEmpty(companyState.jBatchState.batch) || companyState.jBatchState.sentBatch)
  ) {
    throw new Error('COMPANY_SUCCESSOR_RESERVE_PROOF_REQUIRES_EMPTY_BATCH');
  }
  const outstandingDebt = await actors.jadapter.depository.debtOutstanding(
    actors.boardCompany.id,
    shares.controlTokenId,
  );
  if (outstandingDebt !== 0n) {
    throw new Error(`COMPANY_SUCCESSOR_CONTROL_DEBT_NOT_ZERO:${outstandingDebt}`);
  }

  const amount = 1n;
  const recipient = zeroPadValue(signer, 32).toLowerCase();
  const beforeReserve = await actors.jadapter.getReserves(
    actors.boardCompany.id,
    shares.controlTokenId,
  );
  const beforeCustody = await actors.jadapter.entityProvider.balanceOf(
    actors.jadapter.addresses.depository,
    shares.controlExternalTokenId,
  );
  const beforeRecipient = await actors.jadapter.entityProvider.balanceOf(
    signer,
    shares.controlExternalTokenId,
  );

  await executeCompanyAction(env, actors.boardCompany, [{
    type: 'r2e',
    data: { receivingEntity: recipient, tokenId: shares.controlTokenId, amount },
  }, { type: 'j_broadcast', data: {} }]);
  await syncChain(env, 12);

  const afterReserve = await actors.jadapter.getReserves(
    actors.boardCompany.id,
    shares.controlTokenId,
  );
  const afterCustody = await actors.jadapter.entityProvider.balanceOf(
    actors.jadapter.addresses.depository,
    shares.controlExternalTokenId,
  );
  const afterRecipient = await actors.jadapter.entityProvider.balanceOf(
    signer,
    shares.controlExternalTokenId,
  );
  if (afterReserve !== beforeReserve - amount) {
    throw new Error(`COMPANY_SUCCESSOR_RESERVE_DELTA_INVALID:${beforeReserve}:${afterReserve}`);
  }
  if (afterCustody !== beforeCustody - amount) {
    throw new Error(`COMPANY_SUCCESSOR_CUSTODY_DELTA_INVALID:${beforeCustody}:${afterCustody}`);
  }
  if (afterRecipient !== beforeRecipient + amount) {
    throw new Error(`COMPANY_SUCCESSOR_ERC1155_DELTA_INVALID:${beforeRecipient}:${afterRecipient}`);
  }
};
