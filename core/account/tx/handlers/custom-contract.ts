import { getCreate2Address, keccak256, ZeroHash } from 'ethers';
import type { AccountTx } from '../../../types/account';
import type { AccountDraftReplica } from '../../state/account-state-draft';
import { deriveDelta } from '../../utils';
import { addHold, releaseHold } from '../hold-utils';
import { accountTxApplied, accountTxValidationRejected } from '../apply-result';
import type { ApplyAccountTxResult } from '../apply-types';
import type { AccountCustomContract, CustomContractEffect } from '../../../types/finance/custom-contract';
import { createDeltaDraft, commitDeltaDraft, getOffdeltaRepresentationError } from '../delta-utils';

class CustomContractReject extends Error {}
const validateEffects = (clause: AccountCustomContract, effects: CustomContractEffect[]) => {
  for (const effect of effects) {
    const allowance = clause.allowances.find(value => value.tokenId === effect.tokenId);
    if (!allowance || effect.amount > allowance.leftAllowance || effect.amount < -allowance.rightAllowance) {
      throw new CustomContractReject('CUSTOM_CONTRACT_EFFECT_EXCEEDS_ALLOWANCE');
    }
  }
};

const planDeltas = (account: AccountDraftReplica, id: string, clause: AccountCustomContract,
  release: boolean, effects: CustomContractEffect[] = []) => {
  validateEffects(clause, effects);
  return clause.allowances.map(allowance => {
    if (!account.state.deltas.has(allowance.tokenId)) throw new CustomContractReject('CUSTOM_CONTRACT_TOKEN_MISSING');
    const delta = createDeltaDraft(account.state, allowance.tokenId);
    for (const [side, amount] of [['left', allowance.rightAllowance], ['right', allowance.leftAllowance]] as const) {
      if (!release && deriveDelta(delta, side === 'left').outCapacity < amount) throw new CustomContractReject('CUSTOM_CONTRACT_CAPACITY');
      const error = release ? releaseHold(delta, side, amount, () => 'CUSTOM_CONTRACT_HOLD_UNDERFLOW') : addHold(delta, side, amount);
      // An active clause owns these committed holds. Underflow is internal
      // corruption, not a sender reject; preserve fail-stop evidence.
      if (error) { if (release) throw new Error(error); throw new CustomContractReject(error); }
    }
    delta.offdelta += effects.find(effect => effect.tokenId === allowance.tokenId)?.amount ?? 0n;
    const error = getOffdeltaRepresentationError(account.state, delta, undefined,
      release ? { excludeId: id } : { addedAllowance: allowance });
    if (error) throw new CustomContractReject(error);
    return delta;
  });
};

const confirm = (account: AccountDraftReplica, id: string, clause: AccountCustomContract, byLeft: boolean): void => {
  const resolution = clause.resolution;
  if (!resolution || resolution.proposerIsLeft === byLeft) throw new CustomContractReject('CUSTOM_CONTRACT_COUNTERPARTY_REQUIRED');
  const deltas = planDeltas(account, id, clause, true, resolution.effects);
  deltas.forEach(delta => commitDeltaDraft(account.state, delta));
  account.state.subcontracts.del(id);
};

/** Frame signer is authority. Approval binds creation height and revision, so
 * stale confirmation cannot spend a recreated id or a replaced resolution. */
export const handleCustomContract = (
  account: AccountDraftReplica, tx: Extract<AccountTx, { type: 'subcontract_transition' }>,
  byLeft: boolean, factoryAddress: string,
): ApplyAccountTxResult => {
  try {
    const data = tx.data;
    const current = account.state.subcontracts.get(data.id);
    if (data.kind === 'propose') {
      if (current || account.state.subcontracts.size >= 16) throw new CustomContractReject('CUSTOM_CONTRACT_ID_OR_LIMIT');
      const expected = getCreate2Address(factoryAddress, ZeroHash, keccak256(data.program.initcode)).toLowerCase();
      if (expected !== data.program.transformerAddress) throw new CustomContractReject('CUSTOM_CONTRACT_ADDRESS_MISMATCH');
      account.state.subcontracts.put(data.id, { ...data.program, status: 'proposed', proposerIsLeft: byLeft,
        createdHeight: account.currentHeight + 1, revision: 1 });
    } else {
      if (!current || current.createdHeight !== data.createdHeight || current.revision !== data.revision) {
        throw new CustomContractReject('CUSTOM_CONTRACT_STALE_TRANSITION');
      }
      if (data.kind === 'approve' || data.kind === 'reject') {
        if (current.status !== 'proposed' || current.proposerIsLeft === byLeft) throw new CustomContractReject('CUSTOM_CONTRACT_COUNTERPARTY_REQUIRED');
        if (data.kind === 'reject') account.state.subcontracts.del(data.id);
        else {
          const deltas = planDeltas(account, data.id, current, false);
          deltas.forEach(delta => commitDeltaDraft(account.state, delta));
          account.state.subcontracts.put(data.id, { ...current, status: 'active', revision: current.revision + 1 });
        }
      } else {
        if (current.status !== 'active') throw new CustomContractReject('CUSTOM_CONTRACT_NOT_ACTIVE');
        if (data.kind === 'confirm') {
          confirm(account, data.id, current, byLeft);
        } else if (data.kind === 'resolve') {
          validateEffects(current, data.effects);
          account.state.subcontracts.put(data.id, { ...current, revision: current.revision + 1,
            resolution: { proposerIsLeft: byLeft, leftArguments: data.leftArguments,
              rightArguments: data.rightArguments, effects: data.effects } });
        }
      }
    }
    return accountTxApplied([`custom_contract:${data.kind}:${data.id}`]);
  } catch (error) {
    if (error instanceof CustomContractReject) return accountTxValidationRejected(error.message, []);
    throw error;
  }
};
