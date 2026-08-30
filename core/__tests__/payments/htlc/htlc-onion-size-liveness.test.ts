import { expect, test } from 'bun:test';
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { HTLC, LIMITS } from '../../../config/constants';
import { computeHtlcEnvelopeContextHash, createOnionEnvelopes } from '../../../protocol/htlc/codec/envelope';
import { decodeOnionLayer } from '../../../protocol/htlc/codec/onion';
import { decryptOpaqueHtlcBytes } from '../../../protocol/htlc/multi-recipient';

const hex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
const bytes32 = (value: number): string => `0x${value.toString(16).padStart(64, '0')}`;
const privateKeyAt = (index: number): string => hex(sha256(new TextEncoder().encode(`htlc-max-hop:${index}`)));

test('MAX_HOPS opaque onion stays bounded and every Entity decrypts one layer', async () => {
  const route = Array.from({ length: HTLC.MAX_HOPS + 1 }, (_, index) => bytes32(index + 1));
  const privateKeys = new Map(route.map((entityId, index) => [entityId, privateKeyAt(index)]));
  const publicKeys = new Map([...privateKeys].map(([entityId, privateKey]) => [
    entityId,
    hex(x25519.getPublicKey(Uint8Array.from(privateKey.slice(2).match(/../g)!, value => Number.parseInt(value, 16)))),
  ]));
  const domain = { chainId: 31337, depositoryAddress: `0x${'11'.repeat(20)}` };
  const domains = Array.from({ length: HTLC.MAX_HOPS }, () => domain);
  const forwards = new Map(route.slice(1, -1).map(entityId => [entityId, 1n]));
  const timelock = BigInt(HTLC.MIN_TIMELOCK_DELTA_MS * (HTLC.MAX_HOPS + 2));
  const revealBeforeHeight = HTLC.MIN_REVEAL_HEIGHT_DELTA_BLOCKS * (HTLC.MAX_HOPS + 2);
  const hashlock = bytes32(0x7_002);
  const envelope = await createOnionEnvelopes(
    route, bytes32(0x7_003), publicKeys, domains, forwards,
    undefined, 1,
    { hashlock, tokenId: 1, senderLockAmount: 1n, timelock, revealBeforeHeight },
    hopIndex => privateKeyAt(route.length + hopIndex),
  );
  expect(new TextEncoder().encode(JSON.stringify(envelope)).byteLength).toBeLessThan(LIMITS.MAX_FRAME_SIZE_BYTES);

  let encrypted = envelope;
  for (let hopIndex = 1; hopIndex < route.length; hopIndex += 1) {
    const hop = route[hopIndex]!;
    const amount = hopIndex === 1 ? 1n : forwards.get(route[hopIndex - 1]!)!;
    const plaintext = decryptOpaqueHtlcBytes(
      encrypted, publicKeys.get(hop)!, privateKeys.get(hop)!,
      computeHtlcEnvelopeContextHash({
        fromEntityId: route[hopIndex - 1]!, toEntityId: hop, domain,
        hashlock, tokenId: 1, amount,
        timelock: timelock - BigInt(hopIndex - 1) * BigInt(HTLC.MIN_TIMELOCK_DELTA_MS),
        revealBeforeHeight: revealBeforeHeight - (hopIndex - 1) * HTLC.MIN_REVEAL_HEIGHT_DELTA_BLOCKS,
      }),
    );
    const layer = decodeOnionLayer(plaintext);
    if ('finalRecipient' in layer) {
      expect(hopIndex).toBe(HTLC.MAX_HOPS);
      break;
    }
    expect(layer.nextHop).toBe(route[hopIndex + 1]);
    encrypted = layer.innerEnvelope;
  }
}, 30_000);
