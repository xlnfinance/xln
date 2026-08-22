import { expect, test } from 'bun:test';
import { LIMITS } from '../../../../config/constants';
import { encodeCanonicalConsensusValue } from '../../../../protocol/serialization/canonical-consensus-value';
import { resolveRuntimeWsMaxMessageBytes, serializeWsMessage } from '../../../../network/p2p/ws-protocol';
import { deriveEncryptionKeyPair, encryptPayload } from '../../../../protocol/crypto/p2p-crypto';
import { parseProfile } from '../../../../entity/profile';

const id = (value: number): string => `0x${value.toString(16).padStart(64, '0')}`;
const address = `0x${'11'.repeat(20)}`;
const key = `0x${'22'.repeat(32)}`;

const routeProfile = (index: number) => ({
  entityId: id(index + 1), entityEncryptionPublicKey: key, name: `hop-${index + 1}`,
  avatar: '', bio: '', website: '', lastUpdated: 1, runtimeId: address, runtimeEncPubKey: key,
  publicAccounts: [], wsUrl: null, relays: [],
  metadata: {
    isHub: true, routingFeePPM: 1, baseFee: 0n,
    profileHanko: `0x${'33'.repeat(65)}`,
  },
  accounts: [index, index + 2].filter(value => value > 0 && value <= 101).map(counterparty => ({
    counterpartyId: id(counterparty),
    domain: { chainId: 31337, depositoryAddress: address },
    tokenCapacities: { 1: { inCapacity: 1n, outCapacity: 1n } },
  })),
});

test('100-hop minimal full-profile context fits protocol but transport remains the tighter bound', () => {
  const context = {
    version: 1, proposerReplicaId: `${id(1)}:${address}`, entityId: id(1), proposerSignerId: address,
    parentFrameHash: id(999), height: 1,
    gossipProfiles: Array.from({ length: 101 }, (_, index) => routeProfile(index)),
    peerAssertions: [], htlc: { version: 1, entries: [], originated: [] },
  };
  const contextBytes = new TextEncoder().encode(encodeCanonicalConsensusValue(context)).byteLength;
  expect(contextBytes).toBeLessThan(LIMITS.MAX_FRAME_SIZE_BYTES);

  const encryptedPayload = encryptPayload({ entityInputs: [{ entityId: id(1), signerId: address, entityTxs: [{ type: 'fixture', data: context }] }] }, deriveEncryptionKeyPair('context-size-target').publicKey);
  expect(() => serializeWsMessage({ type: 'entity_inputs', from: 'source', to: 'target', payload: encryptedPayload, encrypted: true }))
    .not.toThrow();
  expect(contextBytes).toBeLessThan(resolveRuntimeWsMaxMessageBytes());
});

test('one signed gossip profile is rejected above one MiB independently of aggregate frame limits', () => {
  expect(() => parseProfile({
    entityId: id(1),
    bio: 'x'.repeat(LIMITS.MAX_PROFILE_BYTES),
  })).toThrow('GOSSIP_PROFILE_BYTE_LIMIT_EXCEEDED');
});
