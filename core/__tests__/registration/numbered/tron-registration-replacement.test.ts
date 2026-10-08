import { expect, test } from 'bun:test';
import { ethers } from 'ethers';
import vector from './tron-registration-replacement-vector.json';
import { createEmptyEnv } from '../../../runtime';
import { buildNumberedRegistrationRequest } from '../../../runtime/registration/numbered/numbered-registration-codec';
import { canonicalEntitySeed } from '../../../runtime/registration/entity-creation';
import { applyNumberedRegistrationReplacement } from '../../../runtime/registration/numbered/numbered-registration-replacement';
import { assertNumberedRegistrationTxAuthorized } from '../../../runtime/registration/numbered/numbered-registration-auth';
import { validateRuntimeTx } from '../../../runtime/decode/runtime-tx';
import type { PendingNumberedRegistration, ReplaceNumberedRegistrationData } from '../../../runtime/types';

const setup = () => {
  const env = createEmptyEnv(vector.seed);
  const jurisdiction = { name: 'Native TVM', address: 'http://127.0.0.1:18545/jsonrpc', chainId: vector.chainId,
    depositoryAddress: vector.contracts.depository, entityProviderAddress: vector.contracts.entityProvider };
  env.state.jReplicas.set(jurisdiction.name, { name: jurisdiction.name, chainId: vector.chainId, blockNumber: 0n,
    stateRoot: null, mempool: [], blockDelayMs: 0, lastBlockTimestamp: 0, position: { x: 0, y: 0, z: 0 },
    contracts: vector.contracts, watcherReceiptCommitment: 'tron-rpc-attested' });
  const request = buildNumberedRegistrationRequest(env, { jurisdiction, payerSignerId: vector.old.runtimeId,
    intentId: ethers.id(vector.seed), entities: [{ name: 'Native durable registration', validators: [vector.old.runtimeId],
      threshold: 1n, localSignerId: vector.old.runtimeId, entitySeed: canonicalEntitySeed(vector.seed) }] });
  const data: ReplaceNumberedRegistrationData = structuredClone(vector.replacement.acceptedTx.data);
  const pending: PendingNumberedRegistration = { status: 'pending', request, requestHash: data.requestHash,
    rawTransaction: vector.old.raw, transactionHash: vector.old.hash, transactionNonce: 0 };
  env.infrastructure ??= {};
  env.infrastructure.numberedRegistrationIntents = new Map([[request.intentId, pending]]);
  return { env, data, pending };
};

test('genuine expired native registration replaces one exact wire and replay is idempotent', () => {
  const { env, data, pending } = setup();
  applyNumberedRegistrationReplacement(env, data);
  const replaced = env.infrastructure?.numberedRegistrationIntents?.get(data.intentId);
  expect(replaced).toEqual({ ...pending, rawTransaction: vector.replacement.raw, transactionHash: vector.replacement.hash });
  applyNumberedRegistrationReplacement(env, data);
  expect(env.infrastructure?.numberedRegistrationIntents?.size).toBe(1);
  expect(env.infrastructure?.numberedRegistrationIntents?.get(data.intentId)).toBe(replaced);
});

test('replacement rejects wrong old hash, absent expiry, EVM policy, changed intent and malformed duplicate evidence', () => {
  for (const mutate of [
    (data: ReplaceNumberedRegistrationData) => { data.previousTransactionHash = ethers.ZeroHash; },
    (data: ReplaceNumberedRegistrationData) => { data.evidence.timestamp = 1; },
    (data: ReplaceNumberedRegistrationData) => { data.requestHash = ethers.ZeroHash; },
    (data: ReplaceNumberedRegistrationData) => { data.rawTransaction = `0x${data.rawTransaction.slice(2).toUpperCase()}`; },
  ]) {
    const { env, data, pending } = setup(); mutate(data);
    expect(() => applyNumberedRegistrationReplacement(env, data)).toThrow();
    expect(env.infrastructure?.numberedRegistrationIntents?.get(pending.request.intentId)).toBe(pending);
  }
  const { env, data } = setup();
  applyNumberedRegistrationReplacement(env, data);
  expect(() => applyNumberedRegistrationReplacement(env, { ...data, evidence: { ...data.evidence, blockHash: ethers.ZeroHash } })).toThrow();
  const replica = env.state.jReplicas.get('Native TVM');
  if (!replica) throw new Error('NATIVE_VECTOR_REPLICA_MISSING');
  delete replica.watcherReceiptCommitment;
  expect(() => applyNumberedRegistrationReplacement(env, data)).toThrow('NATIVE_REQUIRED');
});

test('replacement is a strict decoded internal Runtime command', () => {
  const { data } = setup();
  const tx = { type: 'replaceNumberedRegistrationIntent' as const, data };
  expect(validateRuntimeTx(tx, 'VECTOR')).toBe(tx);
  expect(() => assertNumberedRegistrationTxAuthorized(tx, false)).toThrow('EXTERNAL_RUNTIME_TX_REJECTED');
  expect(() => validateRuntimeTx({ ...tx, data: { ...data, extra: true } }, 'VECTOR')).toThrow();
});
