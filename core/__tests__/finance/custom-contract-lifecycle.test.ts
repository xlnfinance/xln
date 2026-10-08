import { expect, test } from 'bun:test';
import { getCreate2Address, keccak256, ZeroHash } from 'ethers';
import { accountTransitionView, beginAccountTransition, discardAccountTransition, publishAccountTransition } from '../../account/state/candidate-overlay';
import { handleCustomContract } from '../../account/tx/handlers/custom-contract';
import { createDefaultDelta } from '../../account/state/delta';
import { computeAccountStateRoot } from '../../account/commitment/state-root';
import { buildAccountProofBody } from '../../protocol/dispute/proof-builder';
import { entity, makeAccount, putTestAccountDelta } from '../helpers/cross-j';
import { validateCustomContractTransition } from '../../account/tx-validation/custom-contract';
import type { CustomContractTransition } from '../../types/finance/custom-contract';
import vectors from '../../../jurisdictions/test/fixtures/custom-contracts.json';
import { applyAccountDisputeFinality } from '../../account/settlement/j-finality';

const factory = `0x${'3'.repeat(40)}`; const id = entity('aa'); const artifact = vectors['conditional-payment'];
const program = { transformerAddress: getCreate2Address(factory, ZeroHash, keccak256(artifact.initcode)).toLowerCase(),
  initcode: artifact.initcode, source: artifact.source, contractName: artifact.contractName,
  compilerVersion: artifact.compilerVersion, schemas: artifact.schemas, encodedBatch: '0x',
  allowances: [{ tokenId: 7, leftAllowance: 0n, rightAllowance: 100n }] };
const create = () => {
  const account = makeAccount(entity('11'), entity('22'));
  putTestAccountDelta(account, { ...createDefaultDelta(7), collateral: 1000n, ondelta: 1000n });
  return account;
};
const apply = (account: ReturnType<typeof create>, data: CustomContractTransition, byLeft: boolean) => {
  validateCustomContractTransition(data); const owner = beginAccountTransition(account);
  const result = handleCustomContract(accountTransitionView(owner), { type: 'subcontract_transition', data }, byLeft, factory);
  if (result.ok) { publishAccountTransition(account, owner, 'mutableTx'); account.currentHeight++; }
  else discardAccountTransition(owner);
  return result;
};
const reference = (account: ReturnType<typeof create>) => {
  const clause = account.state.subcontracts?.get(id); if (!clause) throw new Error('TEST_CLAUSE_MISSING');
  return { id, createdHeight: clause.createdHeight, revision: clause.revision };
};

test('bilateral approval reserves exact capacity; confirmed resolution changes delta once', () => {
  const account = create(); expect(apply(account, { id, kind: 'propose', program }, true).ok).toBe(true);
  expect(account.state.deltas.get(7)?.leftHold).toBe(0n);
  expect(buildAccountProofBody(account, factory).runtimeProofBody.transformers).toHaveLength(0);
  expect(apply(account, { ...reference(account), kind: 'approve' }, true).ok).toBe(false);
  expect(apply(account, { ...reference(account), kind: 'approve' }, false).ok).toBe(true);
  expect(account.state.deltas.get(7)?.leftHold).toBe(100n);
  expect(buildAccountProofBody(account, factory).runtimeProofBody.transformers).toHaveLength(1);
  expect(apply(account, { ...reference(account), kind: 'resolve', leftArguments: '0x', rightArguments: '0x', effects: [{ tokenId: 7, amount: -100n }] }, true).ok).toBe(true);
  const confirmation = { ...reference(account), kind: 'confirm' as const };
  expect(apply(account, confirmation, true).ok).toBe(false);
  expect(apply(account, confirmation, false).ok).toBe(true);
  expect(account.state.deltas.get(7)?.offdelta).toBe(-100n); expect(account.state.deltas.get(7)?.leftHold).toBe(0n);
  const root = computeAccountStateRoot(account.state);
  expect(apply(account, confirmation, false).ok).toBe(false); expect(computeAccountStateRoot(account.state)).toBe(root);
});
test('approval rejection on a later token leaves every hold and the root unchanged', () => {
  const account = create();
  const multi = { ...program, allowances: [...program.allowances, { tokenId: 99, leftAllowance: 100n, rightAllowance: 0n }] };
  expect(apply(account, { id, kind: 'propose', program: multi }, true).ok).toBe(true);
  const root = computeAccountStateRoot(account.state);
  expect(apply(account, { ...reference(account), kind: 'approve' }, false).ok).toBe(false);
  expect(computeAccountStateRoot(account.state)).toBe(root); expect(account.state.deltas.get(7)?.leftHold).toBe(0n);
});
test('cancellation releases holds; stale approval cannot authorize a recreated id', () => {
  const account = create(); apply(account, { id, kind: 'propose', program }, true);
  const old = { ...reference(account), kind: 'approve' as const };
  apply(account, old, false);
  apply(account, { ...reference(account), kind: 'resolve', leftArguments: '0x', rightArguments: '0x', effects: [] }, false);
  expect(apply(account, { ...reference(account), kind: 'confirm' }, true).ok).toBe(true);
  expect(account.state.deltas.get(7)?.offdelta).toBe(0n); expect(account.state.deltas.get(7)?.leftHold).toBe(0n);
  apply(account, { id, kind: 'propose', program }, true);
  expect(apply(account, old, false).ok).toBe(false);
});
test('resolution outside the signed allowance rejects without changing the root', () => {
  const account = create(); apply(account, { id, kind: 'propose', program }, true);
  apply(account, { ...reference(account), kind: 'approve' }, false);
  const root = computeAccountStateRoot(account.state);
  expect(apply(account, { ...reference(account), kind: 'resolve', leftArguments: '0x', rightArguments: '0x',
    effects: [{ tokenId: 7, amount: -101n }] }, true).ok).toBe(false);
  expect(computeAccountStateRoot(account.state)).toBe(root);
});
test('J finality retires custom clauses and holds together', () => {
  const account = create(); apply(account, { id, kind: 'propose', program }, true);
  apply(account, { ...reference(account), kind: 'approve' }, false);
  applyAccountDisputeFinality(account, 1, [7]);
  expect(account.state.subcontracts?.size).toBe(0);
  expect(account.state.deltas.get(7)?.leftHold).toBe(0n);
  expect(account.state.deltas.get(7)?.rightHold).toBe(0n);
  expect(buildAccountProofBody(account, factory).runtimeProofBody.transformers).toHaveLength(0);
});
