import { describe, expect, test } from 'bun:test';
import { SigningKey, computeAddress } from 'ethers';

import { deriveSignerKeySync, registerSignerKey } from '../account/crypto';
import { computeCanonicalEntityConsensusStateHash } from '../entity/consensus/state-root';
import { rawEventToJEvents } from '../jurisdiction/adapter/j-event-payloads';
import { normalizeJurisdictionEvent } from '../jurisdiction/machine/event-normalization';
import { createEmptyEnv } from '../runtime';
import type { RuntimeReplica } from '../runtime/types';
import {
  entity,
  installJurisdictions,
  makeJurisdiction,
  makeState,
} from './helpers/cross-j';
import { applyJEventRange } from './helpers/j-history';

const hex = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`;
const jurisdiction = makeJurisdiction('Ethereum', 1, '11', '12');
const entityId = entity('01');
const counterpartyId = entity('02');

const envAt = (scannedThroughHeight: number, disputeDelaySeconds: number): RuntimeReplica => {
  const env = createEmptyEnv(`dispute-started-timeout:${scannedThroughHeight}:${disputeDelaySeconds}`);
  env.state.timestamp = 1_700_000_000_000;
  env.quietRuntimeLogs = true;
  installJurisdictions(env, jurisdiction);
  const replica = env.state.jReplicas.get(jurisdiction.name)!;
  replica.blockNumber = BigInt(scannedThroughHeight);
  // Field name still says Blocks in config; unit is now seconds on L1.
  replica.defaultDisputeDelayBlocks = disputeDelaySeconds;
  return env;
};

describe('canonical DisputeStarted timeout', () => {
  test('normalization and watcher decoding require the exact on-chain value', () => {
    const eventData = {
      sender: entityId,
      counterentity: counterpartyId,
      nonce: '1',
      proofbodyHash: `0x${'55'.repeat(32)}`,
      watchSeed: `0x${'66'.repeat(32)}`,
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
      disputeTimeout: '1700005861',
      disputeStartTimestamp: '1700000000',
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
      'starterIncrementedArguments',
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

  test('finalized event applies its timeout independently of validator-local config', async () => {
    const privateKey = deriveSignerKeySync('certified-j-height:event', '1');
    const validatorId = computeAddress(new SigningKey(hex(privateKey)).compressedPublicKey).toLowerCase();
    registerSignerKey('certified-j-height:event-runtime', validatorId, privateKey);
    const state = makeState(entityId, validatorId, jurisdiction, counterpartyId);
    const event = normalizeJurisdictionEvent({
      type: 'DisputeStarted',
      data: {
        sender: entityId,
        counterentity: counterpartyId,
        nonce: '1',
        proofbodyHash: `0x${'55'.repeat(32)}`,
        watchSeed: `0x${'66'.repeat(32)}`,
        starterInitialArguments: '0x',
        starterIncrementedArguments: '0x',
        disputeTimeout: 1_700_005_761,
        disputeStartTimestamp: 1_700_000_000,
      },
    })!;
    const applyWithConfig = async (height: number, delay: number) => {
      const env = envAt(height, delay);
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
    const lagging = await applyWithConfig(110, 5);
    const leading = await applyWithConfig(130, 5_760);

    expect(lagging.newState.accounts.get(counterpartyId)?.activeDispute?.disputeTimeout).toBe(1_700_005_761);
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
    const event = normalizeJurisdictionEvent({
      type: 'DisputeStarted',
      data: {
        sender: entityId,
        counterentity: counterpartyId,
        nonce: '9007199254740993',
        proofbodyHash: `0x${'55'.repeat(32)}`,
        watchSeed: `0x${'66'.repeat(32)}`,
        starterInitialArguments: '0x',
        starterIncrementedArguments: '0x',
        disputeTimeout: 1_700_005_761,
        disputeStartTimestamp: 1_700_000_000,
      },
    })!;
    const env = envAt(110, 5);
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
