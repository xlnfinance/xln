/**
 * XLN Networking Layer
 *
 * Peer-to-peer communication, gossip protocol, and relay infrastructure.
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

// Profile signing (anti-spoofing)
export { signProfile, verifyProfileSignature, hasValidProfileSignature } from './profile-signing';
