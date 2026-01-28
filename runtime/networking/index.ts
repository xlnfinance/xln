/**
 * XLN Networking Layer
 *
 * ARCHITECTURE: "Dumb pipe" transport - all security at consensus layer.
 *
 * This layer provides:
 * - WebSocket relay for message routing between runtimes
 * - Gossip protocol for entity profile discovery
 * - X25519 encryption for private peer-to-peer messages
 * - Profile signing for anti-spoofing
 *
 * SECURITY MODEL:
 * - NO replay protection here (handled by accountFrame heights in consensus)
 * - NO transaction validation here (handled by entity/account validators)
 * - Profile signatures prevent identity spoofing
 * - Even malicious relay can't forge transactions (needs validator keys)
 *
 * See individual module headers for detailed security documentation.
 */

// Gossip protocol
export { createGossipLayer, loadPersistedProfiles } from './gossip';
export type { Profile, GossipLayer, BoardValidator, BoardMetadata } from './gossip';
export { buildEntityProfile, createProfileBroadcastTx } from './gossip-helper';

// P2P overlay
export { RuntimeP2P } from './p2p';
export type { P2PConfig } from './p2p';

// WebSocket protocol
export { serializeWsMessage, deserializeWsMessage, makeMessageId, makeHelloNonce, buildHelloMessage, hashHelloMessage } from './ws-protocol';
export type { RuntimeWsMessage, RuntimeWsAuth, RuntimeWsMessageType } from './ws-protocol';

// WebSocket client/server
export { RuntimeWsClient } from './ws-client';
export type { RuntimeWsClientOptions } from './ws-client';
export { startRuntimeWsServer } from './ws-server';
export type { RuntimeWsServerOptions } from './ws-server';

// Encryption
export {
  deriveEncryptionKeyPair,
  encryptMessage,
  decryptMessage,
  encryptJSON,
  decryptJSON,
  pubKeyToHex,
  hexToPubKey,
} from './p2p-crypto';
export type { P2PKeyPair } from './p2p-crypto';

// Profile signing (uses same Hanko mechanism as accountFrames)
export { signProfile, signProfileSync, verifyProfileSignature, hasValidProfileSignature, computeProfileHash } from './profile-signing';
