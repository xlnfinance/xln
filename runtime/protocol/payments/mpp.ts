import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

export type MppJsonValue =
  | null
  | string
  | number
  | boolean
  | MppJsonValue[]
  | { [key: string]: MppJsonValue };

export type MppJsonRecord = { [key: string]: MppJsonValue };

export type MppChallenge = {
  id: string;
  realm: string;
  method: string;
  intent: string;
  request: string;
  digest?: string;
  expires?: string;
  description?: string;
  opaque?: string;
  extensions?: Record<string, string>;
};

export type MppChallengeBindingInput = Omit<MppChallenge, 'id' | 'description' | 'extensions'>;

export type MppCredential = {
  challenge: MppChallenge;
  source?: string;
  payload: MppJsonRecord;
};

export type MppReceipt = {
  status: 'success';
  method: string;
  timestamp: string;
  reference: string;
};

const PAYMENT_SCHEME = 'Payment';
const BASE64URL_NO_PAD_RE = /^[A-Za-z0-9_-]+$/;
const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const LOWER_ALPHA_RE = /^[a-z]+$/;
const FORBIDDEN_EXTENSION_KEYS = new Set([
  'id',
  'realm',
  'method',
  'intent',
  'request',
  'digest',
  'expires',
  'description',
  'opaque',
]);

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const compareAscii = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const toUtf8Bytes = (value: string): Uint8Array => utf8Encoder.encode(value);

const bytesToBase64Url = (bytes: Uint8Array): string => {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url');
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
};

const base64UrlToBytes = (value: string, context: string): Uint8Array => {
  assertBase64UrlNoPad(value, context);
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64url'));
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const assertBase64UrlNoPad = (value: string, context: string): void => {
  if (!BASE64URL_NO_PAD_RE.test(value) || value.includes('=') || value.length % 4 === 1) {
    throw new Error(`${context}:MPP_BASE64URL_NOPAD_INVALID`);
  }
};

const assertNonEmptyString = (value: unknown, context: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${context}:MPP_STRING_REQUIRED`);
  }
  return value;
};

const normalizeMppJsonValue = (value: unknown, context: string, stack: object[] = []): MppJsonValue => {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${context}:MPP_JSON_NUMBER_INVALID`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeMppJsonValue(item, `${context}[${index}]`, stack));
  }
  if (isRecord(value)) {
    if (stack.includes(value)) throw new Error(`${context}:MPP_JSON_CIRCULAR`);
    stack.push(value);
    try {
      const normalized: MppJsonRecord = {};
      for (const key of Object.keys(value).sort()) {
        const child = value[key];
        if (child === undefined || typeof child === 'function' || typeof child === 'symbol' || typeof child === 'bigint') {
          throw new Error(`${context}.${key}:MPP_JSON_UNSUPPORTED_VALUE`);
        }
        normalized[key] = normalizeMppJsonValue(child, `${context}.${key}`, stack);
      }
      return normalized;
    } finally {
      stack.pop();
    }
  }
  throw new Error(`${context}:MPP_JSON_UNSUPPORTED_VALUE`);
};

const canonicalJsonFromNormalized = (value: MppJsonValue): string => {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonFromNormalized).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => {
      const child = value[key];
      if (child === undefined) throw new Error(`MPP_JSON.${key}:MPP_JSON_UNSUPPORTED_VALUE`);
      return `${JSON.stringify(key)}:${canonicalJsonFromNormalized(child)}`;
    })
    .join(',')}}`;
};

export const canonicalizeMppJson = (value: unknown): string =>
  canonicalJsonFromNormalized(normalizeMppJsonValue(value, 'MPP_JSON'));

export const encodeMppJson = (value: unknown): string =>
  bytesToBase64Url(toUtf8Bytes(canonicalizeMppJson(value)));

export const decodeMppJson = <T = MppJsonValue>(value: string): T => {
  const text = utf8Decoder.decode(base64UrlToBytes(value, 'MPP_JSON'));
  const parsed = JSON.parse(text) as unknown;
  normalizeMppJsonValue(parsed, 'MPP_JSON');
  return parsed as T;
};

const validateChallenge = (challenge: MppChallenge): MppChallenge => {
  const normalized: MppChallenge = {
    id: assertNonEmptyString(challenge.id, 'MPP_CHALLENGE_ID'),
    realm: assertNonEmptyString(challenge.realm, 'MPP_CHALLENGE_REALM'),
    method: assertNonEmptyString(challenge.method, 'MPP_CHALLENGE_METHOD'),
    intent: assertNonEmptyString(challenge.intent, 'MPP_CHALLENGE_INTENT'),
    request: assertNonEmptyString(challenge.request, 'MPP_CHALLENGE_REQUEST'),
  };
  if (!LOWER_ALPHA_RE.test(normalized.method)) throw new Error('MPP_CHALLENGE_INVALID_METHOD');
  if (!LOWER_ALPHA_RE.test(normalized.intent)) throw new Error('MPP_CHALLENGE_INVALID_INTENT');
  assertBase64UrlNoPad(normalized.request, 'MPP_CHALLENGE_REQUEST');
  for (const key of ['digest', 'expires', 'description', 'opaque'] as const) {
    const value = challenge[key];
    if (value === undefined) continue;
    normalized[key] = assertNonEmptyString(value, `MPP_CHALLENGE_${key.toUpperCase()}`);
  }
  if (normalized.opaque !== undefined) assertBase64UrlNoPad(normalized.opaque, 'MPP_CHALLENGE_OPAQUE');
  if (challenge.extensions !== undefined) {
    normalized.extensions = {};
    for (const [key, value] of Object.entries(challenge.extensions).sort(([left], [right]) => compareAscii(left, right))) {
      if (!HTTP_TOKEN_RE.test(key) || FORBIDDEN_EXTENSION_KEYS.has(key)) {
        throw new Error(`MPP_CHALLENGE_EXTENSION_INVALID:${key}`);
      }
      normalized.extensions[key] = assertNonEmptyString(value, `MPP_CHALLENGE_EXTENSION:${key}`);
    }
  }
  return normalized;
};

const challengeToWireObject = (challenge: MppChallenge): MppJsonRecord => {
  const normalized = validateChallenge(challenge);
  const record: MppJsonRecord = {
    id: normalized.id,
    intent: normalized.intent,
    method: normalized.method,
    realm: normalized.realm,
    request: normalized.request,
  };
  for (const key of ['description', 'digest', 'expires', 'opaque'] as const) {
    if (normalized[key] !== undefined) record[key] = normalized[key];
  }
  return record;
};

const challengeFromUnknown = (value: unknown, context: string): MppChallenge => {
  if (!isRecord(value)) throw new Error(`${context}:MPP_CHALLENGE_OBJECT_REQUIRED`);
  const challenge: MppChallenge = {
    id: value['id'] as string,
    realm: value['realm'] as string,
    method: value['method'] as string,
    intent: value['intent'] as string,
    request: value['request'] as string,
  };
  for (const key of ['description', 'digest', 'expires', 'opaque'] as const) {
    const optionalValue = value[key];
    if (optionalValue !== undefined) challenge[key] = optionalValue as string;
  }
  return validateChallenge(challenge);
};

const quoteAuthValue = (value: string): string => {
  if (HTTP_TOKEN_RE.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

const formatAuthParam = (key: string, value: string): string => {
  if (!HTTP_TOKEN_RE.test(key)) throw new Error(`MPP_AUTH_PARAM_KEY_INVALID:${key}`);
  return `${key}=${quoteAuthValue(value)}`;
};

export const buildMppChallengeHeader = (challenge: MppChallenge): string => {
  const normalized = validateChallenge(challenge);
  const entries: Array<[string, string | undefined]> = [
    ['id', normalized.id],
    ['realm', normalized.realm],
    ['method', normalized.method],
    ['intent', normalized.intent],
    ['request', normalized.request],
    ['digest', normalized.digest],
    ['expires', normalized.expires],
    ['description', normalized.description],
    ['opaque', normalized.opaque],
  ];
  if (normalized.extensions) {
    for (const [key, value] of Object.entries(normalized.extensions)) entries.push([key, value]);
  }
  return `${PAYMENT_SCHEME} ${entries
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => formatAuthParam(key, value))
    .join(', ')}`;
};

const splitAuthParams = (input: string): string[] => {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && char === ',') {
      parts.push(input.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted || escaped) throw new Error('MPP_AUTH_PARAM_QUOTE_UNCLOSED');
  parts.push(input.slice(start).trim());
  return parts.filter((part) => part.length > 0);
};

const parseAuthValue = (value: string): string => {
  if (!value.startsWith('"')) {
    if (!HTTP_TOKEN_RE.test(value)) throw new Error('MPP_AUTH_PARAM_TOKEN_INVALID');
    return value;
  }
  if (!value.endsWith('"') || value.length < 2) throw new Error('MPP_AUTH_PARAM_QUOTED_INVALID');
  let result = '';
  let escaped = false;
  for (const char of value.slice(1, -1)) {
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    result += char;
  }
  if (escaped) throw new Error('MPP_AUTH_PARAM_QUOTED_INVALID');
  return result;
};

const parsePaymentAuthParams = (header: string): Record<string, string> => {
  const trimmed = header.trim();
  if (trimmed.slice(0, PAYMENT_SCHEME.length).toLowerCase() !== PAYMENT_SCHEME.toLowerCase()) {
    throw new Error('MPP_PAYMENT_SCHEME_REQUIRED');
  }
  const rest = trimmed.slice(PAYMENT_SCHEME.length);
  if (!/^\s+/u.test(rest)) throw new Error('MPP_PAYMENT_PARAMS_REQUIRED');
  const params: Record<string, string> = {};
  for (const part of splitAuthParams(rest.trim())) {
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0) throw new Error('MPP_AUTH_PARAM_INVALID');
    const key = part.slice(0, eqIndex).trim();
    const rawValue = part.slice(eqIndex + 1).trim();
    if (!HTTP_TOKEN_RE.test(key)) throw new Error(`MPP_AUTH_PARAM_KEY_INVALID:${key}`);
    if (Object.prototype.hasOwnProperty.call(params, key)) throw new Error(`MPP_AUTH_PARAM_DUPLICATE:${key}`);
    params[key] = parseAuthValue(rawValue);
  }
  return params;
};

export const parseMppChallengeHeader = (header: string): MppChallenge => {
  const params = parsePaymentAuthParams(header);
  const extensions: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!FORBIDDEN_EXTENSION_KEYS.has(key)) extensions[key] = value;
  }
  const challenge: MppChallenge = {
    id: params['id'] as string,
    realm: params['realm'] as string,
    method: params['method'] as string,
    intent: params['intent'] as string,
    request: params['request'] as string,
  };
  for (const key of ['description', 'digest', 'expires', 'opaque'] as const) {
    const value = params[key];
    if (value !== undefined) challenge[key] = value;
  }
  if (Object.keys(extensions).length > 0) challenge.extensions = extensions;
  return validateChallenge(challenge);
};

const validateCredential = (credential: MppCredential): MppCredential => {
  const payload = normalizeMppJsonValue(credential.payload, 'MPP_CREDENTIAL_PAYLOAD');
  if (!isRecord(payload)) throw new Error('MPP_CREDENTIAL_PAYLOAD_OBJECT_REQUIRED');
  const normalized: MppCredential = {
    challenge: validateChallenge(credential.challenge),
    payload,
  };
  if (credential.source !== undefined) {
    normalized.source = assertNonEmptyString(credential.source, 'MPP_CREDENTIAL_SOURCE');
  }
  return normalized;
};

export const buildMppCredentialHeader = (credential: MppCredential): string => {
  const normalized = validateCredential(credential);
  const record: MppJsonRecord = {
    challenge: challengeToWireObject(normalized.challenge),
    payload: normalized.payload,
  };
  if (normalized.source !== undefined) record['source'] = normalized.source;
  return `${PAYMENT_SCHEME} ${encodeMppJson(record)}`;
};

export const parseMppCredentialHeader = (header: string): MppCredential => {
  const trimmed = header.trim();
  if (trimmed.slice(0, PAYMENT_SCHEME.length).toLowerCase() !== PAYMENT_SCHEME.toLowerCase()) {
    throw new Error('MPP_PAYMENT_SCHEME_REQUIRED');
  }
  if (!/^\s/u.test(trimmed.slice(PAYMENT_SCHEME.length))) throw new Error('MPP_PAYMENT_PARAMS_REQUIRED');
  const encoded = trimmed.slice(PAYMENT_SCHEME.length).trim();
  const decoded = decodeMppJson<MppJsonRecord>(encoded);
  if (!isRecord(decoded)) throw new Error('MPP_CREDENTIAL_OBJECT_REQUIRED');
  const credential: MppCredential = {
    challenge: challengeFromUnknown(decoded['challenge'], 'MPP_CREDENTIAL_CHALLENGE'),
    payload: normalizeMppJsonValue(decoded['payload'], 'MPP_CREDENTIAL_PAYLOAD') as MppJsonRecord,
  };
  if (!isRecord(credential.payload)) throw new Error('MPP_CREDENTIAL_PAYLOAD_OBJECT_REQUIRED');
  if (decoded['source'] !== undefined) credential.source = assertNonEmptyString(decoded['source'], 'MPP_CREDENTIAL_SOURCE');
  return validateCredential(credential);
};

const validateReceipt = (receipt: MppReceipt): MppReceipt => {
  if (receipt.status !== 'success') throw new Error('MPP_RECEIPT_STATUS_INVALID');
  return {
    status: 'success',
    method: assertNonEmptyString(receipt.method, 'MPP_RECEIPT_METHOD'),
    timestamp: assertNonEmptyString(receipt.timestamp, 'MPP_RECEIPT_TIMESTAMP'),
    reference: assertNonEmptyString(receipt.reference, 'MPP_RECEIPT_REFERENCE'),
  };
};

export const buildMppReceiptHeader = (receipt: MppReceipt): string => encodeMppJson(validateReceipt(receipt));

export const parseMppReceiptHeader = (header: string): MppReceipt => {
  const decoded = decodeMppJson<MppJsonRecord>(header.trim());
  if (!isRecord(decoded)) throw new Error('MPP_RECEIPT_OBJECT_REQUIRED');
  return validateReceipt({
    status: decoded['status'] as 'success',
    method: decoded['method'] as string,
    timestamp: decoded['timestamp'] as string,
    reference: decoded['reference'] as string,
  });
};

export const computeMppChallengeId = (secret: string | Uint8Array, challenge: MppChallengeBindingInput): string => {
  const normalized = validateChallenge({ ...challenge, id: 'binding-check' });
  // The optional slots are positional by spec. Do not sort or omit them:
  // `expires||opaque` and `|digest|opaque` must produce different IDs.
  const bindingInput = [
    normalized.realm,
    normalized.method,
    normalized.intent,
    normalized.request,
    normalized.expires ?? '',
    normalized.digest ?? '',
    normalized.opaque ?? '',
  ].join('|');
  const key = typeof secret === 'string' ? toUtf8Bytes(secret) : secret;
  return bytesToBase64Url(hmac(sha256, key, toUtf8Bytes(bindingInput)));
};
