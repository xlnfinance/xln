import { describe, expect, test } from 'bun:test';

import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../account/crypto';
import { encodeBoard, hashBoard } from '../entity/factory';
import {
  assertCertifiedRegistrationEvidence,
  assertCertifiedRegistrationEvidenceStore,
  buildRegistrationEvidenceDigest,
  computeRegistrationEvidenceHash,
} from '../jurisdiction/registration-evidence';
import { applyRuntimeTx } from '../machine/tx-handlers';
import { createEmptyEnv } from '../runtime';
import { buildCertifiedEntityLineagePlan } from '../storage/entity-lineage';
import type { EntityReplica, Env, JReplica, JurisdictionConfig } from '../types';
import {
  buildDurableRuntimeMachineSnapshot,
  restoreDurableRuntimeSnapshot,
} from '../wal/snapshot';
import { addr, makeState } from './helpers/cross-j';
import { installCanonicalRegistrationEvidence } from './helpers/registration-evidence';

const jurisdiction: JurisdictionConfig = {
  name: 'registration-authority',
  address: 'http://127.0.0.1:8545',
  chainId: 31_337,
  depositoryAddress: addr('d1'),
  entityProviderAddress: addr('e1'),
  registrationBlock: 5,
};
const entityId = `0x${'00'.repeat(31)}02`;

const installStack = (env: Env, depth = 2): void => {
  const replica: JReplica = {
    name: jurisdiction.name,
    blockNumber: 7n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 300,
    lastBlockTimestamp: 0,
    position: { x: 0, y: 50, z: 0 },
    chainId: jurisdiction.chainId,
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
    },
    watcherConfirmationDepth: depth,
  };
  env.jReplicas.set(jurisdiction.name, replica);
};

const makeRegisteredRuntime = (seed: string): {
  env: Env;
  replica: EntityReplica;
  boardHash: string;
} => {
  const env = createEmptyEnv(seed);
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  registerSignerKey(env, env.runtimeId!, deriveSignerKeySync(seed, '1'));
  installStack(env);
  const signerId = deriveSignerAddressSync(seed, '2').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync(seed, '2'));
  const state = makeState(entityId, signerId, jurisdiction);
  state.height = 0;
  state.timestamp = 0;
  const boardHash = hashBoard(encodeBoard(state.config, env)).toLowerCase();
  const replica: EntityReplica = {
    entityId,
    signerId,
    state,
    mempool: [],
    isProposer: true,
  };
  env.eReplicas.set(`${entityId}:${signerId}`, replica);
  return { env, replica, boardHash };
};

const resign = <T extends { witnessSignature: string }>(env: Env, evidence: T): T => {
  evidence.witnessSignature = signAccountFrame(
    env,
    env.runtimeId!,
    buildRegistrationEvidenceDigest(evidence as never),
  ).toLowerCase();
  return evidence;
};

describe('validator-local registered H0 authority evidence', () => {
  test('rejects candidate H0 authority without local authenticated receipt evidence', () => {
    const { env } = makeRegisteredRuntime('registration-authority-missing');
    expect(() => buildCertifiedEntityLineagePlan(env))
      .toThrow('STORAGE_ENTITY_LINEAGE_GENESIS_AUTHORITY_EVIDENCE_MISSING');
  });

  test('accepts a real receipt-MPT claim and binds its hash into H0', async () => {
    const { env, replica, boardHash } = makeRegisteredRuntime('registration-authority-valid');
    const evidence = await installCanonicalRegistrationEvidence(
      env,
      jurisdiction,
      entityId,
      boardHash,
    );
    const plan = buildCertifiedEntityLineagePlan(env);
    const anchor = plan.anchorByReplicaKey.get(`${entityId}:${replica.signerId}`);
    expect(anchor?.authorityEvidenceHash).toBe(computeRegistrationEvidenceHash(evidence));
    await expect(assertCertifiedRegistrationEvidenceStore(env)).resolves.toBeUndefined();
  });

  test('rejects external authority/history RuntimeTx ingress', async () => {
    const { env, boardHash } = makeRegisteredRuntime('registration-authority-ingress');
    const evidence = await installCanonicalRegistrationEvidence(
      env,
      jurisdiction,
      entityId,
      boardHash,
    );
    await expect(applyRuntimeTx(env, {
      type: 'recordAuthenticatedJAuthority',
      data: structuredClone(evidence),
    })).rejects.toThrow('J_AUTHORITY_RUNTIME_TX_EXTERNAL_INGRESS_REJECTED');
    await expect(applyRuntimeTx(env, {
      type: 'observeJRange',
      data: {
        entityId,
        signerId: env.eReplicas.values().next().value!.signerId,
        jurisdictionRef: `0x${'11'.repeat(32)}`,
        scannedThroughHeight: 5,
        tipBlockHash: `0x${'22'.repeat(32)}`,
        blocks: [],
      },
    })).rejects.toThrow('J_AUTHORITY_RUNTIME_TX_EXTERNAL_INGRESS_REJECTED');
  });

  test('rejects witness, proof, finality-policy, and safe-scan tampering', async () => {
    const { env, boardHash } = makeRegisteredRuntime('registration-authority-tamper');
    const evidence = await installCanonicalRegistrationEvidence(
      env,
      jurisdiction,
      entityId,
      boardHash,
    );

    const badWitness = structuredClone(evidence);
    badWitness.witnessSignature = `0x${'00'.repeat(65)}`;
    await expect(assertCertifiedRegistrationEvidence(env, badWitness))
      .rejects.toThrow('J_AUTHORITY_WITNESS_SIGNATURE_INVALID');

    const badProof = structuredClone(evidence);
    badProof.encodedReceipt = `${badProof.encodedReceipt.slice(0, -2)}00`;
    resign(env, badProof);
    await expect(assertCertifiedRegistrationEvidence(env, badProof))
      .rejects.toThrow('J_RECEIPT_PROOF_VALUE_MISMATCH');

    const badPolicy = structuredClone(evidence);
    badPolicy.confirmationDepth = 0;
    resign(env, badPolicy);
    await expect(assertCertifiedRegistrationEvidence(env, badPolicy))
      .rejects.toThrow('J_AUTHORITY_FINALITY_POLICY_MISMATCH');

    const unsafeScan = structuredClone(evidence);
    unsafeScan.observedThroughHeight = unsafeScan.observedHeadHeight;
    resign(env, unsafeScan);
    await expect(assertCertifiedRegistrationEvidence(env, unsafeScan))
      .rejects.toThrow('J_AUTHORITY_FINALITY_INSUFFICIENT');
  });

  test('durably restores and fully re-verifies evidence before H0 lineage', async () => {
    const { env, replica, boardHash } = makeRegisteredRuntime('registration-authority-restore');
    const evidence = await installCanonicalRegistrationEvidence(
      env,
      jurisdiction,
      entityId,
      boardHash,
    );
    const snapshot = buildDurableRuntimeMachineSnapshot(env);
    const restored = createEmptyEnv('registration-authority-restore');
    restored.scenarioMode = true;
    restored.eReplicas = new Map([[`${entityId}:${replica.signerId}`, structuredClone(replica)]]);
    restoreDurableRuntimeSnapshot(restored, snapshot);
    await expect(assertCertifiedRegistrationEvidenceStore(restored)).resolves.toBeUndefined();
    expect(buildCertifiedEntityLineagePlan(restored).anchorByReplicaKey
      .get(`${entityId}:${replica.signerId}`)?.authorityEvidenceHash)
      .toBe(computeRegistrationEvidenceHash(evidence));

    const stored = restored.runtimeState!.certifiedRegistrationEvidence!.values().next().value!;
    expect(() => { stored.boardHash = `0x${'44'.repeat(32)}`; }).toThrow();
  });
});
