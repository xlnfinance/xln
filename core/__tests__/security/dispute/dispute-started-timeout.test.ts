import { describe, expect, test } from 'bun:test';
import { SigningKey, computeAddress } from 'ethers';

import { deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { computeCanonicalEntityConsensusStateHash } from '../../../entity/consensus/state-root';
import { rawEventToJEvents } from '../../../jurisdiction/adapter/events/j-event-payloads';
import { normalizeJurisdictionEvent } from '../../../jurisdiction/machine/events/event-normalization';
import { createEmptyEnv } from '../../../runtime';
import type { RuntimeReplica } from '../../../runtime/types';
import {
  entity,
  installJurisdictions,
  makeJurisdiction,
  makeState,
} from '../../helpers/cross-j';
import { applyJEventRange } from '../../helpers/j-history';
import { buildAccountProofBody, hashProofBodyStruct } from '../../../protocol/dispute/proof-builder';

const hex = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`;
const jurisdiction = makeJurisdiction('Ethereum', 1, '11', '12');
const entityId = entity('01');
const counterpartyId = entity('02');

const envAt = (scannedThroughHeight: number): RuntimeReplica => {
  const env = createEmptyEnv(`dispute-started-timeout:${scannedThroughHeight}`);
  env.state.timestamp = 1_700_000_000_000;
  env.quietRuntimeLogs = true;
  installJurisdictions(env, jurisdiction);
  const replica = env.state.jReplicas.get(jurisdiction.name)!;
  replica.blockNumber = BigInt(scannedThroughHeight);
  return env;
};

describe('canonical DisputeStarted timeout', () => {
  test('normalization and watcher decoding require the exact on-chain value', () => {
    const initialProofbody = {
      watchSeed: `0x${'66'.repeat(32)}`,
      leftResponseSeconds: 3600,
      rightResponseSeconds: 2261,
      offdeltas: [],
      tokenIds: [],
      transformers: [],
    };
    const eventData = {
      sender: entityId,
      counterentity: counterpartyId,
      nonce: '1',
      proposerIsLeft: true,
      proofbodyHash: hashProofBodyStruct(initialProofbody),
      initialProofbody,
      watchSeed: `0x${'66'.repeat(32)}`,
      starterInitialArguments: '0x',
      starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
      disputeTimeout: '1700005861',
      disputeStartTimestamp: '1700000000',
      leftResponseSeconds: '3600',
      rightResponseSeconds: '2261',
    };
    const normalized = normalizeJurisdictionEvent({ type: 'DisputeStarted', data: eventData });
    expect(normalized?.data.disputeTimeout).toBe(1_700_005_861);
    expect(normalized?.data.disputeStartTimestamp).toBe(1_700_000_000);
    const { disputeTimeout: _, ...missingTimeout } = eventData;
    expect(normalizeJurisdictionEvent({ type: 'DisputeStarted', data: missingTimeout })).toBeNull();
    const { disputeStartTimestamp: __, ...missingStart } = eventData;
    expect(normalizeJurisdictionEvent({ type: 'DisputeStarted', data: missingStart })).toBeNull();
    for (const requiredField of [
      'watchSeed',
      'starterInitialArguments',
      'starterCounterArguments',
    ] as const) {
      const missingEvidence: Partial<typeof eventData> = { ...eventData };
      delete missingEvidence[requiredField];
      expect(
        normalizeJurisdictionEvent({ type: 'DisputeStarted', data: missingEvidence }),
        requiredField,
      ).toBeNull();
    }

    const raw = { name: 'DisputeStarted', args: eventData, blockNumber: 101 };
    expect(rawEventToJEvents(raw, entityId)[0]?.data.disputeTimeout).toBe(1_700_005_861);
    expect(() => rawEventToJEvents({ ...raw, args: missingTimeout }, entityId))
      .toThrow('J_EVENT_DISPUTE_TIMEOUT_INVALID');
  });

  test('finalized event applies its timeout independently of validator-local scan height', async () => {
    const privateKey = deriveSignerKeySync('certified-j-height:event', '1');
    const validatorId = computeAddress(new SigningKey(hex(privateKey)).compressedPublicKey).toLowerCase();
    registerSignerKey('certified-j-height:event-runtime', validatorId, privateKey);
    const state = makeState(entityId, validatorId, jurisdiction, counterpartyId);
    const account = state.accounts.get(counterpartyId)!;
    const { proofBodyStruct: proofbody, proofBodyHash: proofbodyHash } = buildAccountProofBody(account, `0x${'99'.repeat(20)}`);
    const event = normalizeJurisdictionEvent({
      type: 'DisputeStarted',
      data: {
        sender: entityId,
        counterentity: counterpartyId,
        nonce: '1',
        proposerIsLeft: true,
        proofbodyHash,
        initialProofbody: proofbody,
        watchSeed: account.state.watchSeed,
        starterInitialArguments: '0x',
        starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
        disputeTimeout: 1_700_000_020,
        disputeStartTimestamp: 1_700_000_000,
        leftResponseSeconds: 10,
        rightResponseSeconds: 10,
      },
    })!;
    const applyAtHeight = async (height: number) => {
      const env = envAt(height);
      env.runtimeSeed = 'certified-j-height:event-runtime';
      return applyJEventRange(state, {
        from: validatorId,
        jurisdictionRef: jurisdiction.name,
        event,
        observedAt: 1,
        blockNumber: 1,
        blockHash: `0x${'77'.repeat(32)}`,
        transactionHash: `0x${'88'.repeat(32)}`,
      }, env);
    };
    const lagging = await applyAtHeight(110);
    const leading = await applyAtHeight(130);

    expect(lagging.newState.accounts.get(counterpartyId)?.activeDispute?.disputeTimeout).toBe(1_700_000_020);
    expect(lagging.newState.accounts.get(counterpartyId)?.activeDispute?.disputeStartTimestamp)
      .toBe(1_700_000_000);
    expect(computeCanonicalEntityConsensusStateHash(lagging.newState))
      .toBe(computeCanonicalEntityConsensusStateHash(leading.newState));
  });

  test('oversized Solidity nonce cannot round or mutate Account state', async () => {
    const privateKey = deriveSignerKeySync('dispute-nonce-boundary', '1');
    const validatorId = computeAddress(new SigningKey(hex(privateKey)).compressedPublicKey).toLowerCase();
    registerSignerKey('dispute-nonce-boundary-runtime', validatorId, privateKey);
    const state = makeState(entityId, validatorId, jurisdiction, counterpartyId);
    const before = computeCanonicalEntityConsensusStateHash(state);
    const account = state.accounts.get(counterpartyId)!;
    const { proofBodyStruct: initialProofbody, proofBodyHash } = buildAccountProofBody(
      account,
      `0x${'99'.repeat(20)}`,
    );
    const event = normalizeJurisdictionEvent({
      type: 'DisputeStarted',
      data: {
        sender: entityId,
        counterentity: counterpartyId,
        nonce: '9007199254740993',
        proposerIsLeft: true,
        proofbodyHash: proofBodyHash,
        initialProofbody,
        watchSeed: account.state.watchSeed,
        starterInitialArguments: '0x',
        starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
        disputeTimeout: 1_700_000_020,
        disputeStartTimestamp: 1_700_000_000,
        leftResponseSeconds: 10,
        rightResponseSeconds: 10,
      },
    })!;
    const env = envAt(110);
    env.runtimeSeed = 'dispute-nonce-boundary-runtime';

    await expect(applyJEventRange(state, {
      from: validatorId,
      jurisdictionRef: jurisdiction.name,
      event,
      observedAt: 1,
      blockNumber: 1,
      blockHash: `0x${'77'.repeat(32)}`,
      transactionHash: `0x${'88'.repeat(32)}`,
    }, env)).rejects.toThrow(
      'J_EVENT_DISPUTE_NONCE_INVALID:9007199254740993',
    );
    expect(computeCanonicalEntityConsensusStateHash(state)).toBe(before);
  });
});
