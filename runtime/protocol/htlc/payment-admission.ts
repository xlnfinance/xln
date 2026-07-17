import { NobleCryptoProvider } from '../crypto/noble';
import type { EntityInput, EntityState, EntityTx, Env } from '../../types';
import type { Profile } from '../../networking/gossip';
import { canonicalizeProfile, getValidatorEncryptionManifestFromBoard } from '../../networking/gossip';
import {
  computeEntityProfileCertificationComponents,
  profileToEntityProfileDescriptor,
  type EntityProfileDescriptor,
} from '../../networking/profile-descriptor';
import { computeProfileHash, verifyProfileSignature } from '../../networking/profile-signing';
import { calculateDirectionalFeePPM, sanitizeBaseFee, sanitizeFeePPM } from '../../routing/fees';
import { getTokenCapacity } from '../../routing/capacity';
import { resolvePaymentDeadlineWindow } from '../payments/delivery';
import { HTLC } from '../../constants';
import {
  calculateHopRevealHeight,
  calculateHopTimelock,
  calculateRequiredInboundForDesiredForward,
  generateLockId,
  hashHtlcSecret,
} from './utils';
import {
  computeHtlcEnvelopeContextHash,
  createOnionEnvelopes,
  type HtlcEnvelope,
} from './envelope';
import {
  isMultiRecipientCiphertext,
  validateMultiRecipientCiphertext,
} from './multi-recipient';
import type { CertifiedValidatorEncryptionManifest } from './validator-encryption';
import { verifyHankoForHash } from '../../hanko/signing';
import { encodeCanonicalEntityConsensusValue } from '../../entity/consensus/state-root';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardHash,
} from '../../jurisdiction/board-registry';
import { assertNoConsensusVisibleHtlcPaymentSecrets } from './consensus-secret-guard';
import { getDeterministicHtlcTestSecret } from './test-secret-capability';

type HtlcPaymentTx = Extract<EntityTx, { type: 'htlcPayment' }>;
type PreparedRouteProfile = NonNullable<HtlcPaymentTx['data']['preparedRouteProfiles']>[number];
type RoutingProfile = Pick<Profile, 'entityId' | 'accounts'> & {
  metadata: Pick<Profile['metadata'], 'routingFeePPM' | 'baseFee'>;
};

export type ValidatedPreparedHtlcPayment = Readonly<{
  targetEntityId: string;
  tokenId: number;
  recipientAmount: bigint;
  route: string[];
  description: string;
  deliveryMode: 'instant' | 'async';
  startedAtMs: number;
  hashlock: string;
  senderLockAmount: bigint;
  totalFee: bigint;
  lockId: string;
  timelock: bigint;
  revealBeforeHeight: number;
  nextHop: string;
  envelope: HtlcEnvelope;
}>;

const normalizeEntityId = (value: unknown, code: string): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(code);
  return normalized;
};

const parsePositiveBigInt = (value: unknown, code: string): bigint => {
  let parsed: bigint;
  try {
    parsed = typeof value === 'bigint' ? value : BigInt(String(value));
  } catch {
    throw new Error(code);
  }
  if (parsed <= 0n) throw new Error(code);
  return parsed;
};

const parseNonNegativeBigInt = (value: unknown, code: string): bigint => {
  let parsed: bigint;
  try {
    parsed = typeof value === 'bigint' ? value : BigInt(String(value));
  } catch {
    throw new Error(code);
  }
  if (parsed < 0n) throw new Error(code);
  return parsed;
};

const normalizeRoute = (route: unknown, senderId: string, targetId: string): string[] => {
  if (!Array.isArray(route) || route.length < 2) throw new Error('HTLC_PAYMENT_ROUTE_INVALID');
  const normalized = route.map((entry) => normalizeEntityId(entry, 'HTLC_PAYMENT_ROUTE_ENTITY_INVALID'));
  if (normalized[0] !== senderId) throw new Error('HTLC_PAYMENT_ROUTE_SENDER_MISMATCH');
  if (normalized[normalized.length - 1] !== targetId) throw new Error('HTLC_PAYMENT_ROUTE_TARGET_MISMATCH');
  if (normalized.length - 1 > HTLC.MAX_HOPS) throw new Error('HTLC_PAYMENT_ROUTE_TOO_LONG');
  const selfRoute = senderId === targetId;
  const intermediaries = normalized.slice(1, -1);
  const validSelfRoute = selfRoute
    && intermediaries.length >= 2
    && new Set(intermediaries).size === intermediaries.length
    && !intermediaries.includes(senderId);
  if ((!selfRoute && new Set(normalized).size !== normalized.length) || (selfRoute && !validSelfRoute)) {
    throw new Error('HTLC_PAYMENT_ROUTE_LOOP');
  }
  return normalized;
};

const normalizeDescription = (value: unknown): string => {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error('HTLC_PAYMENT_DESCRIPTION_TYPE_INVALID');
  const description = value.trim();
  if (description.length > 256) throw new Error('HTLC_PAYMENT_DESCRIPTION_TOO_LONG');
  return description;
};

const normalizePreparedTimestamp = (value: unknown, frameTimestamp: number): number => {
  const startedAtMs = Number(value);
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs <= 0 || startedAtMs > frameTimestamp) {
    throw new Error('HTLC_PAYMENT_STARTED_AT_INVALID');
  }
  return startedAtMs;
};

const normalizePreparationHeight = (value: unknown, code: string): number => {
  const height = Number(value);
  if (!Number.isSafeInteger(height) || height < 0) throw new Error(code);
  return height;
};

const normalizeSecret = (value: unknown): string => {
  const secret = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(secret)) throw new Error('HTLC_PAYMENT_SECRET_INVALID');
  return secret;
};

const generateIngressSecret = (): string => {
  if (!globalThis.crypto?.getRandomValues) throw new Error('HTLC_PAYMENT_SECURE_RANDOM_UNAVAILABLE');
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

const normalizeHashlock = (value: unknown): string => {
  const hashlock = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hashlock)) throw new Error('HTLC_PAYMENT_HASHLOCK_INVALID');
  return hashlock;
};

const RAW_PAYMENT_REQUIRED_FIELDS = ['amount', 'route', 'targetEntityId', 'tokenId'] as const;
const RAW_PAYMENT_OPTIONAL_FIELDS = ['deliveryMode', 'description', 'hashlock', 'startedAtMs'] as const;
const PREPARED_PAYMENT_FIELDS = [
  'amount',
  'deliveryMode',
  'description',
  'hashlock',
  'preparedAtEntityHeight',
  'preparedAtJHeight',
  'preparedEnvelope',
  'preparedHopForwardAmounts',
  'preparedLockId',
  'preparedRevealBeforeHeight',
  'preparedRouteProfiles',
  'preparedSenderLockAmount',
  'preparedTimelock',
  'preparedTotalFee',
  'route',
  'startedAtMs',
  'targetEntityId',
  'tokenId',
] as const;

const assertExactPaymentFields = (
  data: HtlcPaymentTx['data'],
  mode: 'raw' | 'prepared',
): void => {
  const actual = Object.keys(data).sort();
  if (mode === 'prepared') {
    if (Object.prototype.hasOwnProperty.call(data, 'secret')) {
      throw new Error('HTLC_PAYMENT_SECRET_CONSENSUS_FORBIDDEN');
    }
    const expected = [...PREPARED_PAYMENT_FIELDS].sort();
    if (encodeCanonicalEntityConsensusValue(actual) !== encodeCanonicalEntityConsensusValue(expected)) {
      throw new Error('HTLC_PAYMENT_PREPARED_FIELDS_INVALID');
    }
    return;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'secret')) {
    throw new Error('HTLC_PAYMENT_EXPLICIT_SECRET_FORBIDDEN');
  }
  const allowed = new Set<string>([...RAW_PAYMENT_REQUIRED_FIELDS, ...RAW_PAYMENT_OPTIONAL_FIELDS]);
  if (actual.some((field) => !allowed.has(field))) throw new Error('HTLC_PAYMENT_RAW_FIELDS_INVALID');
  if (RAW_PAYMENT_REQUIRED_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(data, field))) {
    throw new Error('HTLC_PAYMENT_RAW_FIELDS_INVALID');
  }
};

const requireProfiles = (env: Env): Profile[] => {
  if (!env.gossip || typeof env.gossip.getProfiles !== 'function') {
    throw new Error('HTLC_PAYMENT_GOSSIP_UNAVAILABLE');
  }
  return env.gossip.getProfiles();
};

const uniqueProfile = <T extends { entityId: string }>(profiles: T[], entityId: string): T => {
  const matches = profiles.filter((profile) => profile.entityId.toLowerCase() === entityId);
  if (matches.length !== 1) {
    throw new Error(`HTLC_PAYMENT_PROFILE_MATCH_COUNT: entity=${entityId} matches=${matches.length}`);
  }
  return matches[0]!;
};

const resolveRoute = async (
  env: Env,
  state: EntityState,
  tx: HtlcPaymentTx,
  amount: bigint,
  targetEntityId: string,
): Promise<string[]> => {
  if (tx.data.route.length > 0) return normalizeRoute(tx.data.route, state.entityId.toLowerCase(), targetEntityId);
  if (state.accounts.has(targetEntityId)) return [state.entityId.toLowerCase(), targetEntityId];
  if (!env.gossip) throw new Error('HTLC_PAYMENT_GOSSIP_UNAVAILABLE');
  const paths = await env.gossip.getNetworkGraph().findPaths(state.entityId, targetEntityId, amount, tx.data.tokenId);
  const selected = paths[0]?.path;
  if (!selected) throw new Error(`HTLC_PAYMENT_ROUTE_NOT_FOUND: target=${targetEntityId}`);
  return normalizeRoute(selected, state.entityId.toLowerCase(), targetEntityId);
};

const feeForHop = (
  profile: RoutingProfile,
  nextHop: string,
  tokenId: number,
): { feePpm: number; baseFee: bigint } => {
  const account = profile.accounts.find((candidate) => candidate.counterpartyId.toLowerCase() === nextHop);
  const capacity = getTokenCapacity(account?.tokenCapacities, tokenId);
  return {
    feePpm: calculateDirectionalFeePPM(
      sanitizeFeePPM(profile.metadata.routingFeePPM ?? 1, 1),
      capacity?.outCapacity ?? 0n,
      capacity?.inCapacity ?? 0n,
    ),
    baseFee: sanitizeBaseFee(profile.metadata.baseFee ?? 0n),
  };
};

const quoteRoute = (
  profiles: RoutingProfile[],
  route: string[],
  tokenId: number,
  recipientAmount: bigint,
): { senderLockAmount: bigint; hopForwardAmounts: Map<string, bigint> } => {
  let inbound = recipientAmount;
  const forwards = new Map<string, bigint>();
  for (let index = route.length - 2; index >= 1; index -= 1) {
    const intermediary = route[index]!;
    const nextHop = route[index + 1]!;
    forwards.set(intermediary, inbound);
    const fee = feeForHop(uniqueProfile(profiles, intermediary), nextHop, tokenId);
    inbound = calculateRequiredInboundForDesiredForward(inbound, fee.feePpm, fee.baseFee);
  }
  return { senderLockAmount: inbound, hopForwardAmounts: forwards };
};

const certifiedDefaultProposerSignerId = (
  board: Profile['metadata']['board'],
  entityId: string,
): string => {
  const signerId = String(board.validators[0]?.signerId ?? '').trim().toLowerCase();
  if (!signerId) throw new Error(`HTLC_PAYMENT_DEFAULT_PROPOSER_REQUIRED: entity=${entityId}`);
  return signerId;
};

const certifyRouteProfiles = async (
  env: Env,
  profiles: Profile[],
  route: string[],
): Promise<{
  manifests: Map<string, CertifiedValidatorEncryptionManifest>;
  routeProfiles: PreparedRouteProfile[];
}> => {
  const certified = new Map<string, CertifiedValidatorEncryptionManifest>();
  const routeProfiles: PreparedRouteProfile[] = [];
  for (const [routeIndex, entityId] of route.entries()) {
    const profile = uniqueProfile(profiles, entityId);
    const verification = await verifyProfileSignature(profile, env);
    if (!verification.valid) {
      throw new Error(`HTLC_PAYMENT_PROFILE_HANKO_INVALID: entity=${entityId} reason=${verification.reason || 'unknown'}`);
    }
    const canonicalProfile = canonicalizeProfile(profile);
    const manifest = getValidatorEncryptionManifestFromBoard(canonicalProfile.entityId, canonicalProfile.metadata.board);
    const descriptor = profileToEntityProfileDescriptor(canonicalProfile);
    const components = computeEntityProfileCertificationComponents(descriptor);
    const hanko = canonicalProfile.metadata.profileHanko;
    if (!hanko || computeProfileHash(canonicalProfile) !== components.profileHash) {
      throw new Error(`HTLC_PAYMENT_PROFILE_CERTIFICATION_MISMATCH: entity=${entityId}`);
    }
    certified.set(entityId, {
      manifest,
      recipientSignerId: certifiedDefaultProposerSignerId(canonicalProfile.metadata.board, entityId),
      profileCertification: {
        profileHash: components.profileHash,
        routingStateHash: components.routingStateHash,
        hanko,
      },
    });
    // The sender manifest is needed only inside the locally constructed
    // reverse secret-offer chain. Route-profile bytes remain unchanged: every
    // remote hop still carries exactly one independently verifiable profile.
    if (routeIndex > 0) routeProfiles.push({ descriptor, profileHanko: hanko });
  }
  return { manifests: certified, routeProfiles };
};

const paymentDeadlines = (
  anchor: Readonly<{ timestamp: number; jHeight: number }>,
  deliveryMode: 'instant' | 'async',
  route: string[],
) => {
  const window = resolvePaymentDeadlineWindow({
    mode: deliveryMode,
    // Freeze only Entity-certified state. Validator-local watcher tips may
    // differ and must never influence a signed payment proposal.
    runtimeJHeight: anchor.jHeight,
    timestamp: anchor.timestamp,
    totalHops: route.length - 1,
  });
  return {
    timelock: calculateHopTimelock(window.baseTimelock, 0, route.length - 1),
    revealBeforeHeight: calculateHopRevealHeight(window.baseHeight, 0, route.length - 1),
  };
};

const forwardAmountEntries = (
  route: string[],
  amounts: ReadonlyMap<string, bigint>,
): Array<{ entityId: string; amount: string }> => route.slice(1, -1).map((entityId) => {
  const amount = amounts.get(entityId);
  if (amount === undefined) throw new Error(`HTLC_PAYMENT_FORWARD_AMOUNT_MISSING:${entityId}`);
  return { entityId, amount: amount.toString() };
});

const validateCanonicalProfileDescriptor = (raw: unknown): EntityProfileDescriptor => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('HTLC_PAYMENT_PREPARED_ROUTE_PROFILE_DESCRIPTOR_INVALID');
  }
  const { version, ...profileFields } = raw as EntityProfileDescriptor & Record<string, unknown>;
  if (version !== 'xln:entity-profile:v2') {
    throw new Error('HTLC_PAYMENT_PREPARED_ROUTE_PROFILE_DESCRIPTOR_VERSION_INVALID');
  }
  let canonical: EntityProfileDescriptor;
  try {
    canonical = profileToEntityProfileDescriptor(canonicalizeProfile({
      ...profileFields,
      lastUpdated: 1,
      runtimeId: 'descriptor-validation',
      runtimeEncPubKey: `0x${'11'.repeat(32)}`,
      wsUrl: null,
      relays: [],
    } as unknown as Profile));
  } catch (error) {
    throw new Error(
      `HTLC_PAYMENT_PREPARED_ROUTE_PROFILE_DESCRIPTOR_INVALID:${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    encodeCanonicalEntityConsensusValue(raw)
    !== encodeCanonicalEntityConsensusValue(canonical)
  ) {
    throw new Error('HTLC_PAYMENT_PREPARED_ROUTE_PROFILE_DESCRIPTOR_NON_CANONICAL');
  }
  return canonical;
};

const validatePreparedRouteProfiles = async (
  env: Env,
  observerState: EntityState,
  route: string[],
  routeProfiles: unknown,
): Promise<{
  manifests: Map<string, CertifiedValidatorEncryptionManifest>;
  routingProfiles: RoutingProfile[];
  profiles: PreparedRouteProfile[];
}> => {
  if (!Array.isArray(routeProfiles) || routeProfiles.length !== route.length - 1) {
    throw new Error('HTLC_PAYMENT_PREPARED_ROUTE_PROFILE_COUNT_MISMATCH');
  }
  const manifests = new Map<string, CertifiedValidatorEncryptionManifest>();
  const routingProfiles: RoutingProfile[] = [];
  const profiles: PreparedRouteProfile[] = [];
  for (let index = 0; index < routeProfiles.length; index += 1) {
    const entry = routeProfiles[index] as Partial<PreparedRouteProfile>;
    const descriptor = validateCanonicalProfileDescriptor(entry?.descriptor);
    const expectedEntityId = route[index + 1]!;
    if (normalizeEntityId(descriptor.entityId, 'HTLC_PAYMENT_PREPARED_ROUTE_PROFILE_ENTITY_INVALID') !== expectedEntityId) {
      throw new Error('HTLC_PAYMENT_PREPARED_ROUTE_PROFILE_ORDER_MISMATCH');
    }
    const profileHanko = String(entry.profileHanko || '').trim().toLowerCase();
    if (
      encodeCanonicalEntityConsensusValue(entry)
      !== encodeCanonicalEntityConsensusValue({ descriptor, profileHanko })
    ) {
      throw new Error('HTLC_PAYMENT_PREPARED_ROUTE_PROFILE_NON_CANONICAL');
    }
    const components = computeEntityProfileCertificationComponents(descriptor);
    const registeredBoardHash = resolveObserverCertifiedBoardHash(
      observerState,
      getCertifiedBoardNodeStore(env),
      expectedEntityId,
    );
    const verified = await verifyHankoForHash(
      profileHanko,
      components.profileHash,
      expectedEntityId,
      env,
      registeredBoardHash ? { registeredBoardHash } : undefined,
    );
    if (!verified.valid) throw new Error(`HTLC_PAYMENT_PREPARED_ROUTE_PROFILE_HANKO_INVALID:${expectedEntityId}`);
    const manifest = getValidatorEncryptionManifestFromBoard(expectedEntityId, descriptor.metadata.board);
    if (manifest.hash !== components.manifestHash) {
      throw new Error(`HTLC_PAYMENT_PREPARED_ROUTE_PROFILE_MANIFEST_MISMATCH:${expectedEntityId}`);
    }
    manifests.set(expectedEntityId, {
      manifest,
      recipientSignerId: certifiedDefaultProposerSignerId(descriptor.metadata.board, expectedEntityId),
      profileCertification: {
        profileHash: components.profileHash,
        routingStateHash: components.routingStateHash,
        hanko: profileHanko,
      },
    });
    routingProfiles.push(descriptor);
    profiles.push({ descriptor, profileHanko });
  }
  return { manifests, routingProfiles, profiles };
};

const validatePreparedForwardAmounts = (
  route: string[],
  raw: unknown,
  expected: ReadonlyMap<string, bigint>,
): Array<{ entityId: string; amount: string }> => {
  if (!Array.isArray(raw)) throw new Error('HTLC_PAYMENT_PREPARED_FORWARD_AMOUNTS_REQUIRED');
  const canonical = forwardAmountEntries(route, expected);
  const normalized = raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('HTLC_PAYMENT_PREPARED_FORWARD_AMOUNT_INVALID');
    }
    const record = entry as { entityId?: unknown; amount?: unknown };
    const entityId = normalizeEntityId(record.entityId, 'HTLC_PAYMENT_PREPARED_FORWARD_ENTITY_INVALID');
    const amount = parsePositiveBigInt(record.amount, 'HTLC_PAYMENT_PREPARED_FORWARD_AMOUNT_INVALID');
    if (entityId !== route[index + 1]) throw new Error('HTLC_PAYMENT_PREPARED_FORWARD_AMOUNT_ORDER_MISMATCH');
    return { entityId, amount: amount.toString() };
  });
  if (
    encodeCanonicalEntityConsensusValue(normalized) !== encodeCanonicalEntityConsensusValue(canonical)
    || encodeCanonicalEntityConsensusValue(raw) !== encodeCanonicalEntityConsensusValue(canonical)
  ) {
    throw new Error('HTLC_PAYMENT_PREPARED_FORWARD_AMOUNT_MISMATCH');
  }
  return canonical;
};

type EnvelopeBuildInput = Readonly<{
  route: string[];
  secret: string;
  hashlock: string;
  tokenId: number;
  recipientAmount: bigint;
  senderLockAmount: bigint;
  totalFee: bigint;
  description: string;
  deliveryMode: 'instant' | 'async';
  startedAtMs: number;
  lockId: string;
  timelock: bigint;
  revealBeforeHeight: number;
  manifests: Map<string, CertifiedValidatorEncryptionManifest>;
  routeProfiles: PreparedRouteProfile[];
  hopForwardAmounts: Map<string, bigint>;
}>;

const canonicalEnvelopeSeed = (input: EnvelopeBuildInput): string => encodeCanonicalEntityConsensusValue({
  domain: 'xln:htlc-onion-deterministic-replay:v1',
  route: input.route,
  secret: input.secret,
  hashlock: input.hashlock,
  tokenId: input.tokenId,
  recipientAmount: input.recipientAmount,
  senderLockAmount: input.senderLockAmount,
  totalFee: input.totalFee,
  description: input.description,
  deliveryMode: input.deliveryMode,
  startedAtMs: input.startedAtMs,
  lockId: input.lockId,
  timelock: input.timelock,
  revealBeforeHeight: input.revealBeforeHeight,
  hopForwardAmounts: forwardAmountEntries(input.route, input.hopForwardAmounts),
  routeProfiles: input.routeProfiles.map(({ descriptor, profileHanko }) => {
    const components = computeEntityProfileCertificationComponents(descriptor);
    return {
      entityId: descriptor.entityId,
      manifestHash: components.manifestHash,
      profileHash: components.profileHash,
      routingStateHash: components.routingStateHash,
      profileHanko,
    };
  }),
});

const buildPreparedEnvelope = (input: EnvelopeBuildInput): Promise<HtlcEnvelope> => createOnionEnvelopes(
  input.route,
  input.secret,
  input.manifests,
  new NobleCryptoProvider({ deterministicSeed: canonicalEnvelopeSeed(input) }),
  input.hopForwardAmounts,
  input.description || undefined,
  input.startedAtMs,
  {
    rootLockId: input.lockId,
    hashlock: input.hashlock,
    tokenId: input.tokenId,
    senderLockAmount: input.senderLockAmount,
    timelock: input.timelock,
    revealBeforeHeight: input.revealBeforeHeight,
  },
);

const hasAnyPreparedField = (tx: HtlcPaymentTx): boolean => [
  tx.data.preparedEnvelope,
  tx.data.preparedSenderLockAmount,
  tx.data.preparedTotalFee,
  tx.data.preparedLockId,
  tx.data.preparedTimelock,
  tx.data.preparedRevealBeforeHeight,
  tx.data.preparedAtEntityHeight,
  tx.data.preparedAtJHeight,
  tx.data.preparedRouteProfiles,
  tx.data.preparedHopForwardAmounts,
].some((value) => value !== undefined);

const hasEveryPreparedField = (tx: HtlcPaymentTx): boolean => [
  tx.data.preparedEnvelope,
  tx.data.preparedSenderLockAmount,
  tx.data.preparedTotalFee,
  tx.data.preparedLockId,
  tx.data.preparedTimelock,
  tx.data.preparedRevealBeforeHeight,
  tx.data.preparedAtEntityHeight,
  tx.data.preparedAtJHeight,
  tx.data.preparedRouteProfiles,
  tx.data.preparedHopForwardAmounts,
].every((value) => value !== undefined);

const findIngressEntityState = (env: Env, input: EntityInput): EntityState => {
  const entityId = String(input.entityId || '').trim().toLowerCase();
  const signerId = String(input.signerId || '').trim().toLowerCase();
  const exact = [...env.eReplicas.values()].filter((replica) =>
    replica.entityId.toLowerCase() === entityId && replica.signerId.toLowerCase() === signerId
  );
  if (exact.length !== 1) {
    throw new Error(
      `HTLC_PAYMENT_INGRESS_REPLICA_MATCH_COUNT: entity=${entityId} signer=${signerId} matches=${exact.length}`,
    );
  }
  return { ...exact[0]!.state, timestamp: env.timestamp };
};

export const prepareHtlcPaymentEntityTx = async (
  env: Env,
  state: EntityState,
  tx: HtlcPaymentTx,
): Promise<HtlcPaymentTx> => {
  assertExactPaymentFields(tx.data, 'raw');
  const targetEntityId = normalizeEntityId(tx.data.targetEntityId, 'HTLC_PAYMENT_TARGET_INVALID');
  const recipientAmount = parsePositiveBigInt(tx.data.amount, 'HTLC_PAYMENT_AMOUNT_INVALID');
  if (!Number.isSafeInteger(tx.data.tokenId) || tx.data.tokenId < 0) throw new Error('HTLC_PAYMENT_TOKEN_INVALID');
  const deliveryMode = tx.data.deliveryMode ?? 'async';
  if (deliveryMode !== 'instant' && deliveryMode !== 'async') throw new Error('HTLC_PAYMENT_DELIVERY_MODE_INVALID');
  const injectedSecret = getDeterministicHtlcTestSecret(tx);
  if (!injectedSecret && tx.data.hashlock !== undefined) {
    throw new Error('HTLC_PAYMENT_HASHLOCK_WITHOUT_SECRET');
  }
  const secret = injectedSecret ? normalizeSecret(injectedSecret) : generateIngressSecret();
  const hashlock = hashHtlcSecret(secret).toLowerCase();
  if (tx.data.hashlock !== undefined && normalizeHashlock(tx.data.hashlock) !== hashlock) {
    throw new Error('HTLC_PAYMENT_SECRET_HASH_MISMATCH');
  }
  const startedAtMs = tx.data.startedAtMs === undefined
    ? normalizePreparedTimestamp(state.timestamp, state.timestamp)
    : normalizePreparedTimestamp(tx.data.startedAtMs, state.timestamp);
  if (startedAtMs !== state.timestamp) throw new Error('HTLC_PAYMENT_STARTED_AT_NOT_CURRENT');
  const preparedAtEntityHeight = normalizePreparationHeight(
    state.height,
    'HTLC_PAYMENT_PREPARED_ENTITY_HEIGHT_INVALID',
  );
  const preparedAtJHeight = normalizePreparationHeight(
    state.lastFinalizedJHeight || 0,
    'HTLC_PAYMENT_PREPARED_J_HEIGHT_INVALID',
  );
  const route = await resolveRoute(env, state, tx, recipientAmount, targetEntityId);
  const profiles = requireProfiles(env);
  const quote = quoteRoute(profiles, route, tx.data.tokenId, recipientAmount);
  const deadlines = paymentDeadlines({ timestamp: startedAtMs, jHeight: preparedAtJHeight }, deliveryMode, route);
  const lockId = generateLockId(hashlock, preparedAtEntityHeight, 0, startedAtMs);
  const certified = await certifyRouteProfiles(env, profiles, route);
  const description = normalizeDescription(tx.data.description);
  const totalFee = quote.senderLockAmount - recipientAmount;
  const envelope = await buildPreparedEnvelope({
    route,
    secret,
    hashlock,
    tokenId: tx.data.tokenId,
    recipientAmount,
    senderLockAmount: quote.senderLockAmount,
    totalFee,
    description,
    deliveryMode,
    startedAtMs,
    lockId,
    timelock: deadlines.timelock,
    revealBeforeHeight: deadlines.revealBeforeHeight,
    manifests: certified.manifests,
    routeProfiles: certified.routeProfiles,
    hopForwardAmounts: quote.hopForwardAmounts,
  });
  return {
    type: 'htlcPayment',
    data: {
      targetEntityId,
      tokenId: tx.data.tokenId,
      amount: recipientAmount,
      route,
      deliveryMode,
      startedAtMs,
      hashlock,
      description,
      preparedEnvelope: envelope,
      preparedSenderLockAmount: quote.senderLockAmount.toString(),
      preparedTotalFee: totalFee.toString(),
      preparedLockId: lockId,
      preparedTimelock: deadlines.timelock.toString(),
      preparedRevealBeforeHeight: deadlines.revealBeforeHeight,
      preparedAtEntityHeight,
      preparedAtJHeight,
      preparedRouteProfiles: certified.routeProfiles,
      preparedHopForwardAmounts: forwardAmountEntries(route, quote.hopForwardAmounts),
    },
  };
};

const requirePreparedEnvelope = async (
  nextHop: string,
  tx: HtlcPaymentTx,
  contextHash: string,
  expected: CertifiedValidatorEncryptionManifest,
): Promise<HtlcEnvelope> => {
  const envelope = tx.data.preparedEnvelope;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('HTLC_PAYMENT_PREPARED_ENVELOPE_REQUIRED');
  }
  const keys = Object.keys(envelope).sort();
  if (encodeCanonicalEntityConsensusValue(keys) !== encodeCanonicalEntityConsensusValue(['innerEnvelope', 'nextHop'])) {
    throw new Error('HTLC_PAYMENT_PREPARED_ENVELOPE_SHAPE_INVALID');
  }
  const typed = envelope as HtlcEnvelope;
  if (String(typed.nextHop || '').toLowerCase() !== nextHop || !isMultiRecipientCiphertext(typed.innerEnvelope)) {
    throw new Error('HTLC_PAYMENT_PREPARED_ENVELOPE_NEXT_HOP_MISMATCH');
  }
  validateMultiRecipientCiphertext(
    typed.innerEnvelope,
    nextHop,
    contextHash,
    expected.recipientSignerId,
  );
  if (
    encodeCanonicalEntityConsensusValue(typed.innerEnvelope.manifest)
      !== encodeCanonicalEntityConsensusValue(expected.manifest)
    || encodeCanonicalEntityConsensusValue(typed.innerEnvelope.profileCertification)
      !== encodeCanonicalEntityConsensusValue(expected.profileCertification)
  ) {
    throw new Error('HTLC_PAYMENT_PREPARED_ENVELOPE_CERTIFICATION_MISMATCH');
  }
  return typed;
};

export const validatePreparedHtlcPayment = async (
  env: Env,
  state: EntityState,
  tx: HtlcPaymentTx,
): Promise<ValidatedPreparedHtlcPayment> => {
  assertExactPaymentFields(tx.data, 'prepared');
  const targetEntityId = normalizeEntityId(tx.data.targetEntityId, 'HTLC_PAYMENT_TARGET_INVALID');
  const route = normalizeRoute(tx.data.route, state.entityId.toLowerCase(), targetEntityId);
  const recipientAmount = parsePositiveBigInt(tx.data.amount, 'HTLC_PAYMENT_AMOUNT_INVALID');
  if (!Number.isSafeInteger(tx.data.tokenId) || tx.data.tokenId < 0) throw new Error('HTLC_PAYMENT_TOKEN_INVALID');
  const deliveryMode = tx.data.deliveryMode ?? 'async';
  if (deliveryMode !== 'instant' && deliveryMode !== 'async') throw new Error('HTLC_PAYMENT_DELIVERY_MODE_INVALID');
  const description = normalizeDescription(tx.data.description);
  if (tx.data.description !== description) throw new Error('HTLC_PAYMENT_DESCRIPTION_NON_CANONICAL');
  if (typeof tx.data.startedAtMs !== 'number') throw new Error('HTLC_PAYMENT_STARTED_AT_INVALID');
  const startedAtMs = normalizePreparedTimestamp(tx.data.startedAtMs, state.timestamp);
  const hashlock = normalizeHashlock(tx.data.hashlock);
  const preparedAtEntityHeight = normalizePreparationHeight(
    tx.data.preparedAtEntityHeight,
    'HTLC_PAYMENT_PREPARED_ENTITY_HEIGHT_INVALID',
  );
  const preparedAtJHeight = normalizePreparationHeight(
    tx.data.preparedAtJHeight,
    'HTLC_PAYMENT_PREPARED_J_HEIGHT_INVALID',
  );
  if (preparedAtEntityHeight > state.height) throw new Error('HTLC_PAYMENT_PREPARED_ENTITY_HEIGHT_FUTURE');
  if (preparedAtJHeight > (state.lastFinalizedJHeight || 0)) {
    throw new Error('HTLC_PAYMENT_PREPARED_J_HEIGHT_FUTURE');
  }
  const certified = await validatePreparedRouteProfiles(env, state, route, tx.data.preparedRouteProfiles);
  const quote = quoteRoute(certified.routingProfiles, route, tx.data.tokenId, recipientAmount);
  const senderLockAmount = parsePositiveBigInt(tx.data.preparedSenderLockAmount, 'HTLC_PAYMENT_PREPARED_AMOUNT_INVALID');
  const totalFee = parseNonNegativeBigInt(tx.data.preparedTotalFee, 'HTLC_PAYMENT_PREPARED_FEE_INVALID');
  if (
    typeof tx.data.preparedSenderLockAmount !== 'string'
    || typeof tx.data.preparedTotalFee !== 'string'
    || senderLockAmount !== quote.senderLockAmount
    || totalFee !== quote.senderLockAmount - recipientAmount
  ) {
    throw new Error('HTLC_PAYMENT_PREPARED_QUOTE_MISMATCH');
  }
  validatePreparedForwardAmounts(route, tx.data.preparedHopForwardAmounts, quote.hopForwardAmounts);
  const lockId = String(tx.data.preparedLockId || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(lockId)) throw new Error('HTLC_PAYMENT_PREPARED_LOCK_ID_INVALID');
  if (lockId !== generateLockId(hashlock, preparedAtEntityHeight, 0, startedAtMs).toLowerCase()) {
    throw new Error('HTLC_PAYMENT_PREPARED_LOCK_ID_MISMATCH');
  }
  const timelock = parsePositiveBigInt(tx.data.preparedTimelock, 'HTLC_PAYMENT_PREPARED_TIMELOCK_INVALID');
  const revealBeforeHeight = Number(tx.data.preparedRevealBeforeHeight);
  if (
    typeof tx.data.preparedTimelock !== 'string'
    || !Number.isSafeInteger(revealBeforeHeight)
    || revealBeforeHeight <= 0
  ) {
    throw new Error('HTLC_PAYMENT_PREPARED_REVEAL_HEIGHT_INVALID');
  }
  const deadlines = paymentDeadlines({ timestamp: startedAtMs, jHeight: preparedAtJHeight }, deliveryMode, route);
  if (timelock !== deadlines.timelock || revealBeforeHeight !== deadlines.revealBeforeHeight) {
    throw new Error('HTLC_PAYMENT_PREPARED_DEADLINE_MISMATCH');
  }
  // The proposer seals the onion immediately before Entity admission. A
  // certified J-prefix may still advance in the same Entity frame. The sealed
  // height is conservative in that case, so accept it only while the final
  // recipient still has a future reveal block; every preceding hop then keeps
  // the fixed multi-block upstream enforcement reserve. Never extend/rewrite
  // ciphertext after admission.
  const finalRecipientRevealHeight = revealBeforeHeight
    - Math.max(0, route.length - 2) * HTLC.MIN_REVEAL_HEIGHT_DELTA_BLOCKS;
  if (finalRecipientRevealHeight <= (state.lastFinalizedJHeight || 0)) {
    throw new Error('HTLC_PAYMENT_PREPARED_DEADLINE_UNSAFE');
  }
  const finalRecipientTimelock = timelock
    - BigInt(Math.max(0, route.length - 2) * HTLC.MIN_TIMELOCK_DELTA_MS);
  if (finalRecipientTimelock <= BigInt(state.timestamp) + BigInt(HTLC.MIN_FORWARD_TIMELOCK_MS)) {
    throw new Error('HTLC_PAYMENT_PREPARED_TIMELOCK_UNSAFE');
  }
  const nextHop = route[1]!;
  const contextHash = computeHtlcEnvelopeContextHash({
    entityId: nextHop,
    lockId,
    hashlock,
    tokenId: tx.data.tokenId,
    amount: senderLockAmount,
    timelock,
    revealBeforeHeight,
  });
  const expectedNextHopManifest = certified.manifests.get(nextHop);
  if (!expectedNextHopManifest) throw new Error('HTLC_PAYMENT_PREPARED_NEXT_HOP_MANIFEST_MISSING');
  const envelope = await requirePreparedEnvelope(nextHop, tx, contextHash, expectedNextHopManifest);
  return {
    targetEntityId,
    tokenId: tx.data.tokenId,
    recipientAmount,
    route,
    description,
    deliveryMode,
    startedAtMs,
    hashlock,
    senderLockAmount,
    totalFee,
    lockId,
    timelock,
    revealBeforeHeight,
    nextHop,
    envelope,
  };
};

/** Seal every raw local HTLC before consensus admission and WAL persistence. */
export const prepareHtlcPaymentEntityInputs = async (
  env: Env,
  inputs: readonly EntityInput[],
): Promise<EntityInput[]> => Promise.all(inputs.map(async (input) => {
  const paymentTxs = input.entityTxs?.filter((tx): tx is HtlcPaymentTx => tx.type === 'htlcPayment') ?? [];
  const state = paymentTxs.length > 0 ? findIngressEntityState(env, input) : null;
  const entityTxs = await Promise.all((input.entityTxs ?? []).map(async (tx) => {
    if (tx.type !== 'htlcPayment') return tx;
    if (!state) throw new Error('HTLC_PAYMENT_INGRESS_STATE_MISSING');
    const anyPrepared = hasAnyPreparedField(tx);
    if (anyPrepared && !hasEveryPreparedField(tx)) throw new Error('HTLC_PAYMENT_PREPARED_PAYLOAD_PARTIAL');
    const prepared = anyPrepared ? tx : await prepareHtlcPaymentEntityTx(env, state, tx);
    await validatePreparedHtlcPayment(env, state, prepared);
    return prepared;
  }));
  assertNoConsensusVisibleHtlcPaymentSecrets(entityTxs);
  if (input.entityTxs === undefined) return input;
  return { ...input, entityTxs };
}));
