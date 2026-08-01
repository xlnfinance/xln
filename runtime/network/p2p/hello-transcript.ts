/**
 * Canonical, purpose-separated transcripts for the mutually authenticated WS handshake.
 *
 * A challenge is not authority by itself. Direct peers authenticate the responder's
 * runtime key and the exact signed profile endpoint; relay peers pin the configured
 * canonical public WS audience. Every client signature binds that authority, both
 * roles, both direct-runtime identities and encryption keys, so a different endpoint
 * cannot use XLN as a signing oracle. Key rotation requires a fresh handshake.
 */

import { keccak256, toUtf8Bytes } from 'ethers';

import { serializeTaggedJson } from '../../protocol/serialization';
import { XLN_PROTOCOL_VERSION } from '../../protocol/version';

export const RUNTIME_WS_INITIATOR_ROLE = 'runtime-client' as const;
export const DIRECT_RUNTIME_RESPONDER_ROLE = 'direct-runtime-server' as const;
export const RELAY_RESPONDER_ROLE = 'relay-server' as const;

export type RuntimeWsInitiatorRole = typeof RUNTIME_WS_INITIATOR_ROLE;
export type RuntimeWsResponderRole =
  | typeof DIRECT_RUNTIME_RESPONDER_ROLE
  | typeof RELAY_RESPONDER_ROLE;

export type RuntimeWsAuth = {
  nonce: string;
  signature: string;
  timestamp: number;
};

export type RuntimeWsHandshakeBinding = {
  audience: string;
  initiatorRole: RuntimeWsInitiatorRole;
  responderRole: RuntimeWsResponderRole;
  responderRuntimeId: string;
  responderEncryptionPubKey: string;
};

export type RuntimeWsChallengeTranscript = RuntimeWsHandshakeBinding & {
  challenge: string;
  timestamp: number;
};

export type RuntimeWsHelloTranscript = Omit<RuntimeWsChallengeTranscript, 'timestamp'> & {
  initiatorRuntimeId: string;
  initiatorEncryptionPubKey: string;
  challengeTimestamp: number;
  timestamp: number;
};

export type RuntimeWsAckTranscript = RuntimeWsHelloTranscript & {
  helloTimestamp: number;
  timestamp: number;
};

const HANDSHAKE_DOMAIN = `xln-ws-handshake:v${XLN_PROTOCOL_VERSION}`;

const normalizeIdentity = (value: string): string => value.toLowerCase();
const normalizeKey = (value: string): string => value.toLowerCase();

const encodeTranscript = (purpose: 'challenge' | 'hello' | 'ack', values: readonly unknown[]): string =>
  serializeTaggedJson([HANDSHAKE_DOMAIN, purpose, ...values]);

const bindingValues = (binding: RuntimeWsHandshakeBinding): readonly string[] => [
  binding.audience,
  binding.initiatorRole,
  binding.responderRole,
  normalizeIdentity(binding.responderRuntimeId),
  normalizeKey(binding.responderEncryptionPubKey),
];

export const canonicalizeRuntimeWsAudience = (input: string): string => {
  const parsed = new URL(input);
  const protocol = parsed.protocol === 'http:' || parsed.protocol === 'ws:'
    ? 'ws:'
    : parsed.protocol === 'https:' || parsed.protocol === 'wss:'
      ? 'wss:'
      : '';
  if (!protocol) throw new Error(`WS_HANDSHAKE_AUDIENCE_PROTOCOL_INVALID:${parsed.protocol}`);
  if (parsed.username || parsed.password) throw new Error('WS_HANDSHAKE_AUDIENCE_CREDENTIALS_FORBIDDEN');
  const rawPathname = parsed.pathname || '/';
  const pathname = rawPathname.length > 1 ? rawPathname.replace(/\/+$/, '') : rawPathname;
  return `${protocol}//${parsed.host.toLowerCase()}${pathname}`;
};

export const isLoopbackRuntimeWsHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') return true;
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) return Number(ipv4[1]) === 127 && ipv4.slice(1).every(part => Number(part) <= 255);
  const encodedIpv4 = normalized.match(/^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  return !!encodedIpv4 && (Number.parseInt(encodedIpv4[1] || '', 16) >> 8) === 127;
};

export const isWildcardRuntimeWsHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  return normalized === '0.0.0.0' || normalized === '[::]' || normalized === '::';
};

export const canonicalizePublicRuntimeWsAudience = (input: string): string => {
  const parsed = new URL(input);
  if (isWildcardRuntimeWsHostname(parsed.hostname)) {
    throw new Error(`RUNTIME_WS_PUBLIC_WILDCARD_FORBIDDEN:${parsed.hostname}`);
  }
  if (
    (parsed.protocol === 'ws:' || parsed.protocol === 'http:')
    && !isLoopbackRuntimeWsHostname(parsed.hostname)
  ) {
    throw new Error(`RUNTIME_WS_PUBLIC_PLAINTEXT_FORBIDDEN:${parsed.hostname}`);
  }
  return canonicalizeRuntimeWsAudience(input);
};

export const canonicalizeDirectRuntimeWsAudience = (input: string): string => {
  const parsed = new URL(input);
  if (parsed.hash) throw new Error('DIRECT_RUNTIME_WS_AUDIENCE_FRAGMENT_FORBIDDEN');
  if (isWildcardRuntimeWsHostname(parsed.hostname)) {
    throw new Error(`DIRECT_RUNTIME_WS_AUDIENCE_WILDCARD_FORBIDDEN:${parsed.hostname}`);
  }
  if (
    (parsed.protocol === 'ws:' || parsed.protocol === 'http:')
    && !isLoopbackRuntimeWsHostname(parsed.hostname)
  ) {
    throw new Error(`DIRECT_RUNTIME_WS_PLAINTEXT_PUBLIC_FORBIDDEN:${parsed.hostname}`);
  }
  const audience = canonicalizeRuntimeWsAudience(input);
  return `${audience}${parsed.search}`;
};

export const createRelayHandshakeBinding = (url: string): RuntimeWsHandshakeBinding => ({
  audience: canonicalizeRuntimeWsAudience(url),
  initiatorRole: RUNTIME_WS_INITIATOR_ROLE,
  responderRole: RELAY_RESPONDER_ROLE,
  responderRuntimeId: '',
  responderEncryptionPubKey: '',
});

export const createDirectHandshakeBinding = (
  runtimeId: string,
  encryptionPubKey: string,
  publicWsUrl: string,
): RuntimeWsHandshakeBinding => ({
  audience: canonicalizeDirectRuntimeWsAudience(publicWsUrl),
  initiatorRole: RUNTIME_WS_INITIATOR_ROLE,
  responderRole: DIRECT_RUNTIME_RESPONDER_ROLE,
  responderRuntimeId: normalizeIdentity(runtimeId),
  responderEncryptionPubKey: normalizeKey(encryptionPubKey),
});

export const sameHandshakeBinding = (
  left: RuntimeWsHandshakeBinding,
  right: RuntimeWsHandshakeBinding,
): boolean => serializeTaggedJson(bindingValues(left)) === serializeTaggedJson(bindingValues(right));

export const buildHelloChallengeMessage = (transcript: RuntimeWsChallengeTranscript): string =>
  encodeTranscript('challenge', [...bindingValues(transcript), transcript.timestamp, transcript.challenge]);

export const hashHelloChallenge = (transcript: RuntimeWsChallengeTranscript): string =>
  keccak256(toUtf8Bytes(buildHelloChallengeMessage(transcript)));

export const buildHelloMessage = (transcript: RuntimeWsHelloTranscript): string =>
  encodeTranscript('hello', [
    ...bindingValues(transcript),
    normalizeIdentity(transcript.initiatorRuntimeId),
    normalizeKey(transcript.initiatorEncryptionPubKey),
    transcript.challengeTimestamp,
    transcript.timestamp,
    transcript.challenge,
  ]);

export const hashHelloMessage = (transcript: RuntimeWsHelloTranscript): string =>
  keccak256(toUtf8Bytes(buildHelloMessage(transcript)));

export const buildHelloAckMessage = (transcript: RuntimeWsAckTranscript): string =>
  encodeTranscript('ack', [
    ...bindingValues(transcript),
    normalizeIdentity(transcript.initiatorRuntimeId),
    normalizeKey(transcript.initiatorEncryptionPubKey),
    transcript.challengeTimestamp,
    transcript.helloTimestamp,
    transcript.timestamp,
    transcript.challenge,
  ]);

export const hashHelloAck = (transcript: RuntimeWsAckTranscript): string =>
  keccak256(toUtf8Bytes(buildHelloAckMessage(transcript)));
