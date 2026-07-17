import { describe, expect, spyOn, test } from 'bun:test';
import { SigningKey, computeAddress, keccak256, recoverAddress } from 'ethers';
import {
  clearSignerKeys,
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signDigestBytesWithPrivateKey,
} from '../account/crypto';
import { createEmptyAccountJClaimAccumulator } from '../account/j-claim-accumulator';
import { deriveEncryptionKeyPair, pubKeyToHex } from '../networking/p2p-crypto';
import { RuntimeP2P } from '../networking/p2p';
import {
  collectLocalProfileEncryptionAnnouncements,
  getCompleteProfileEncryptionManifest,
  requireProfileEncryptionManifest,
} from '../networking/profile-encryption';
import { buildEntityProfile } from '../networking/gossip-helper';
import { NobleCryptoProvider } from '../protocol/crypto/noble';
import { generateLazyEntityId } from '../entity/factory';
import { buildQuorumHanko, getEntityConfigBoardHash, verifyHankoForHash } from '../hanko/signing';
import type {
  AccountMachine,
  CertifiedRegistrationEvidence,
  EntityState,
  Env,
  JurisdictionConfig,
  JurisdictionEvent,
  RoutedEntityInput,
} from '../types';
import {
  computeEntityProfileCertificationHash,
  computeValidatorEncryptionAttestationDigest,
  mergeValidatorEncryptionAttestations,
  requireCompleteValidatorEncryptionManifest,
  type ValidatorEncryptionAttestation,
  type ValidatorEncryptionBoard,
} from '../protocol/htlc/validator-encryption';
import {
  decryptForLocalValidator,
  encryptBytesForValidatorManifest,
  encryptForValidatorManifest,
  validateMultiRecipientCiphertext,
} from '../protocol/htlc/multi-recipient';
import { assertNoConsensusVisibleHtlcPaymentSecrets } from '../protocol/htlc/consensus-secret-guard';
import { withDeterministicHtlcTestSecret } from '../protocol/htlc/test-secret-capability';
import { handleCertifyProfileEntityTx } from '../entity/tx/handlers/profile-certification';
import {
  buildEntityProfileDescriptor,
  computeEntityProfileCertificationComponents,
  computeEntityProfileDescriptorHash,
  profileToEntityProfileDescriptor,
} from '../networking/profile-descriptor';
import { createDefaultDelta, validateEntityState } from '../validation-utils';
import { getValidatorEncryptionManifestFromBoard, parseProfile, type Profile } from '../networking/gossip';
import {
  computeProfileHash,
  signProfileRuntimeRoute,
  verifyProfileSignature,
} from '../networking/profile-signing';
import {
  prepareHtlcPaymentEntityInputs,
  prepareHtlcPaymentEntityTx,
  validatePreparedHtlcPayment,
} from '../protocol/htlc/payment-admission';
import { serializeTaggedJson } from '../protocol/serialization';
import {
  createEmptyEnv,
  process as processRuntime,
  startP2P,
  stopP2PAndWait,
} from '../runtime';
import { deriveAccountWatchSeed } from '../account/watch-seed';
import { buildCollectiveEntityProposalTx } from '../entity/authorization';
import { buildSignedEntityCommand } from '../entity/command';
import { signedEntityCommandTx } from '../entity/command-codec';
import { deriveLocalEntityCryptoKeys } from '../entity/crypto';
import { initCrontab } from '../entity/scheduler';
import { applyEntityFrame, applyEntityInput } from '../entity/consensus';
import { handleHtlcPayment } from '../entity/tx/handlers/htlc-payment';
import { handleHtlcResolve } from '../account/tx/handlers/htlc-resolve';
import {
  buildHtlcOnionRevealAcceptedTx,
  hashEncryptedHtlcLayer,
  htlcSecretOfferContextHash,
  validateHtlcOnionAdvanceTx,
} from '../protocol/htlc/onion-advance';
import { hashHtlcSecret } from '../protocol/htlc/utils';
import { handleHtlcOnionAdvance } from '../entity/tx/handlers/htlc-onion-advance';
import { encodeHtlcSecretOffer } from '../protocol/htlc/onion-codec';
import { appendDefaultProposerAcceptedHtlcReveals } from '../entity/htlc-onion-post-commit';
import { createJReplica } from '../scenarios/boot';
import { installCanonicalRegistrationEvidence } from './helpers/registration-evidence';
import {
  applyCertifiedEntityLineagePlan,
  buildCertifiedEntityLineagePlan,
} from '../storage/entity-lineage';
import { recordValidatorJHistory } from '../jurisdiction/local-history';
import { canonicalJurisdictionEventsHash, getJEventJurisdictionRef } from '../jurisdiction/event-observation';
import { buildLocalJPrefixAttestation } from '../jurisdiction/j-prefix-consensus';
import { hydrateEntityStateFromStorage, projectEntityCoreDoc } from '../storage/projections';
import { validateEntityTx } from '../wal/runtime-machine-schema/entity-tx';
import {
  buildConsensusOutputOrigin,
  hashCertifiedEntityOutput,
  hashCertifiedEntityOutputSemantic,
} from '../entity/consensus/output-certification';

const CONTEXT_HASH = `0x${'a7'.repeat(32)}`;
const ROUTING_STATE_HASH = `0x${'b6'.repeat(32)}`;
const SENDER_PRIVATE_KEY = deriveSignerKeySync('htlc-test-sender', '1');
const SENDER_SIGNING_KEY = new SigningKey(`0x${Buffer.from(SENDER_PRIVATE_KEY).toString('hex')}`);
const SENDER_PUBLIC_KEY = SENDER_SIGNING_KEY.publicKey.toLowerCase();
const SENDER_SIGNER = computeAddress(SENDER_PUBLIC_KEY).toLowerCase();
const SENDER_ID = generateLazyEntityId([SENDER_SIGNER], 1n).toLowerCase();
const SENDER_ENCRYPTION = deriveEncryptionKeyPair(
  `0x${Buffer.from(SENDER_PRIVATE_KEY).toString('hex')}:${SENDER_ID}:htlc-v1`,
);
const PROCESS_JURISDICTION = {
  name: 'HTLC process test',
  chainId: 31337,
  depositoryAddress: `0x${'d1'.repeat(20)}`,
  entityProviderAddress: `0x${'e1'.repeat(20)}`,
} satisfies JurisdictionConfig;
const PROCESS_ACCOUNT = `0x${'a1'.repeat(20)}`;
const PROCESS_DELTA_TRANSFORMER = `0x${'f1'.repeat(20)}`;

const installProcessJurisdictionReplica = (
  env: ReturnType<typeof createEmptyEnv>,
) => {
  const replica = env.jReplicas.get(PROCESS_JURISDICTION.name) ?? createJReplica(
    env,
    PROCESS_JURISDICTION.name,
    PROCESS_JURISDICTION.depositoryAddress,
  );
  replica.chainId = PROCESS_JURISDICTION.chainId;
  replica.depositoryAddress = PROCESS_JURISDICTION.depositoryAddress;
  replica.entityProviderAddress = PROCESS_JURISDICTION.entityProviderAddress;
  replica.contracts = {
    account: PROCESS_ACCOUNT,
    depository: PROCESS_JURISDICTION.depositoryAddress,
    entityProvider: PROCESS_JURISDICTION.entityProviderAddress,
    deltaTransformer: PROCESS_DELTA_TRANSFORMER,
  };
  return replica;
};

const hex = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`;
const flipBase64Byte = (value: string): string => `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;

const signDigest = (privateKey: Uint8Array, digest: string): string => {
  const signed = signDigestBytesWithPrivateKey(privateKey, Buffer.from(digest.slice(2), 'hex'));
  return `${hex(signed.signature)}${signed.recovery.toString(16).padStart(2, '0')}`;
};

const signingFixture = (seed: string, _signerLabel: string, weight = 1) => {
  const privateKey = deriveSignerKeySync(seed, '1');
  const signingKey = new SigningKey(hex(privateKey));
  const publicKey = signingKey.publicKey.toLowerCase();
  const signer = computeAddress(publicKey).toLowerCase();
  return {
    signerId: signer,
    signer,
    publicKey,
    weight,
    privateKey,
  };
};

const firstSigning = signingFixture('independent-runtime-a', 'validator-a');
const secondSigning = signingFixture('independent-runtime-b', 'validator-b');
const ENTITY_ID = generateLazyEntityId([
  { name: firstSigning.signer, weight: firstSigning.weight },
  { name: secondSigning.signer, weight: secondSigning.weight },
], 2n).toLowerCase();
const withEncryption = (validator: typeof firstSigning) => {
  const encryption = deriveEncryptionKeyPair(`${hex(validator.privateKey)}:${ENTITY_ID}:htlc-v1`);
  return {
    ...validator,
    encryptionPublicKey: pubKeyToHex(encryption.publicKey),
    encryptionPrivateKey: hex(encryption.privateKey),
  };
};
const first = withEncryption(firstSigning);
const second = withEncryption(secondSigning);
const board: ValidatorEncryptionBoard = {
  entityId: ENTITY_ID,
  threshold: 2,
  validators: [first, second].map(({ signerId, signer, publicKey, weight }) => ({
    signerId,
    signer,
    publicKey,
    weight,
  })),
};

const attest = (validator: typeof first): ValidatorEncryptionAttestation => {
  const body = {
    version: 'xln:validator-encryption-key:v1' as const,
    entityId: ENTITY_ID,
    signerId: validator.signerId,
    signer: validator.signer,
    publicKey: validator.publicKey,
    weight: validator.weight,
    encryptionPublicKey: validator.encryptionPublicKey,
  };
  return {
    ...body,
    signature: signDigest(validator.privateKey, computeValidatorEncryptionAttestationDigest(body)),
  };
};

const certifyManifest = async (manifestHash: string) => {
  const profileHash = computeEntityProfileCertificationHash(manifestHash, ROUTING_STATE_HASH);
  const config = {
    threshold: 2n,
    validators: [first.signer, second.signer],
    shares: { [first.signer]: 1n, [second.signer]: 1n },
  };
  const hanko = await buildQuorumHanko(
    {} as Env,
    ENTITY_ID,
    profileHash,
    [first, second].map((validator) => ({
      signerId: validator.signer,
      signature: signDigest(validator.privateKey, profileHash),
    })),
    config,
  );
  return { profileHash, routingStateHash: ROUTING_STATE_HASH, hanko };
};

const certificationState = (): EntityState => ({
  entityId: ENTITY_ID,
  height: 4,
  timestamp: 400,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    threshold: 2n,
    validators: [first.signerId, second.signerId],
    shares: { [first.signerId]: 1n, [second.signerId]: 1n },
  },
  reserves: new Map(),
  accounts: new Map(),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  entityEncPubKey: first.encryptionPublicKey,
  entityEncPrivKey: first.encryptionPrivateKey,
  profile: { name: 'certified-profile', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
  lockBook: new Map(),
});

const senderState = (): EntityState => ({
  ...certificationState(),
  entityId: SENDER_ID,
  height: 9,
  timestamp: 900,
  config: {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [SENDER_SIGNER],
    shares: { [SENDER_SIGNER]: 1n },
  },
  entityEncPubKey: pubKeyToHex(SENDER_ENCRYPTION.publicKey),
  entityEncPrivKey: hex(SENDER_ENCRYPTION.privateKey),
});

const processSenderState = (
  entityId: string,
  signerId: string,
  encryptionPublicKey: string,
  encryptionPrivateKey: string,
): EntityState => ({
  ...senderState(),
  entityId,
  height: 0,
  timestamp: 900,
  config: {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [signerId],
    shares: { [signerId]: 1n },
    jurisdiction: PROCESS_JURISDICTION,
  },
  accounts: new Map(),
  deferredAccountProposals: new Map(),
  entityEncPubKey: encryptionPublicKey,
  entityEncPrivKey: encryptionPrivateKey,
  swapTradingPairs: [],
  pendingSwapFillRatios: new Map(),
  crontabState: initCrontab(),
});

const anchorManualGenesisReplica = async (
  env: Env,
  state: EntityState,
): Promise<CertifiedRegistrationEvidence | null> => {
  const boardHash = await getEntityConfigBoardHash(env, state.config);
  let evidence: CertifiedRegistrationEvidence | null = null;
  if (boardHash !== state.entityId.toLowerCase()) {
    const jurisdiction = state.config.jurisdiction;
    if (!jurisdiction) throw new Error('HTLC_TEST_REGISTERED_ENTITY_JURISDICTION_MISSING');
    const jReplica = installProcessJurisdictionReplica(env);
    jReplica.watcherConfirmationDepth = 0;
    evidence = await installCanonicalRegistrationEvidence(env, jurisdiction, state.entityId, boardHash);
  }
  applyCertifiedEntityLineagePlan(env, buildCertifiedEntityLineagePlan(env));
  return evidence;
};

const certifyRegisteredBoardPrefix = async (
  env: Env,
  entityId: string,
  signerId: string,
  evidence: CertifiedRegistrationEvidence,
): Promise<void> => {
  const foundationHeight = evidence.activationHeight - 1;
  const events: JurisdictionEvent[] = [{
    type: 'FoundationBootstrapped',
    data: {
      recipient: env.runtimeId!,
      boardHash: `0x${'31'.repeat(32)}`,
      controlTokenId: '2',
      dividendTokenId: '3',
    },
    blockNumber: foundationHeight,
    blockHash: `0x${foundationHeight.toString(16).padStart(2, '0').repeat(32)}`,
    transactionHash: `0x${'41'.repeat(32)}`,
    logIndex: 0,
  }, {
    type: 'EntityRegistered',
    data: {
      entityId,
      entityNumber: BigInt(entityId).toString(),
      boardHash: evidence.boardHash,
    },
    blockNumber: evidence.activationHeight,
    blockHash: evidence.blockHash,
    transactionHash: evidence.transactionHash,
    logIndex: evidence.logIndex,
  }];

  const replicaEntry = Array.from(env.eReplicas.entries()).find(([, candidate]) => (
    candidate.entityId === entityId && candidate.signerId === signerId
  ));
  if (!replicaEntry) throw new Error('HTLC_TEST_AUTHORITY_REPLICA_MISSING');
  const [replicaKey, replica] = replicaEntry;
  const jurisdictionRef = getJEventJurisdictionRef(replica.state.config.jurisdiction);
  const blocks = events.map(event => ({
    jurisdictionRef,
    jHeight: event.blockNumber!,
    jBlockHash: event.blockHash!,
    eventsHash: canonicalJurisdictionEventsHash([event]),
    events: [event],
  }));
  const observeData = {
    entityId,
    signerId,
    jurisdictionRef,
    scannedThroughHeight: evidence.activationHeight,
    tipBlockHash: evidence.blockHash,
    headers: Array.from({ length: evidence.activationHeight }, (_, index) => {
      const jHeight = index + 1;
      return {
        jHeight,
        jBlockHash: events.find((event) => event.blockNumber === jHeight)?.blockHash ??
          `0x${jHeight.toString(16).padStart(64, '0')}`,
      };
    }),
    blocks,
  };
  const tentativeHistory = recordValidatorJHistory(replica.jHistory, observeData, replica.state);
  const attestation = buildLocalJPrefixAttestation(env, {
    ...replica,
    jHistory: tentativeHistory,
  }, tentativeHistory);
  if (!attestation) throw new Error('HTLC_TEST_AUTHORITY_ATTESTATION_MISSING');
  replica.jHistory = tentativeHistory;
  const applied = await applyEntityInput(env, replica, {
    entityId,
    signerId,
    jPrefixAttestations: new Map([[signerId, attestation]]),
  });
  if (
    applied.outcome.kind !== 'committed' ||
    applied.newState.lastFinalizedJHeight < evidence.activationHeight
  ) {
    throw new Error(
      `HTLC_TEST_BOARD_PREFIX_NOT_FINALIZED:${applied.outcome.kind}:` +
      `${applied.newState.lastFinalizedJHeight}:${evidence.activationHeight}`,
    );
  }
  env.eReplicas.set(replicaKey, applied.workingReplica);
};

const paymentAccount = (sourceEntityId: string, targetEntityId: string): AccountMachine => {
  const [leftEntity, rightEntity] = [sourceEntityId, targetEntityId].sort() as [string, string];
  const sourceIsLeft = sourceEntityId === leftEntity;
  const delta = createDefaultDelta(1);
  if (sourceIsLeft) delta.leftCreditLimit = 1_000n;
  else delta.rightCreditLimit = 1_000n;
  const currentFrame: AccountMachine['currentFrame'] = {
    height: 0,
    timestamp: 0,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: '',
    accountStateRoot: `0x${'00'.repeat(32)}`,
    deltas: [],
    stateHash: '',
    byLeft: sourceIsLeft,
  };
  return {
    leftEntity,
    rightEntity,
    domain: {
      chainId: PROCESS_JURISDICTION.chainId,
      depositoryAddress: PROCESS_JURISDICTION.depositoryAddress,
    },
    status: 'active',
    mempool: [],
    currentFrame,
    deltas: new Map([[1, delta]]),
    locks: new Map(),
    swapOffers: new Map(),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: sourceEntityId, toEntity: targetEntityId, nextProofNonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    frameHistory: [],
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    lastFinalizedJHeight: 0,
    watchSeed: deriveAccountWatchSeed({
      runtimeSeed: 'multisig-htlc-process-account',
      entityId: sourceEntityId,
      counterpartyId: targetEntityId,
      timestamp: 900,
    }),
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    jNonce: 0,
  };
};

const certifiedGossipProfile = async (): Promise<Profile> => {
  const manifest = requireCompleteValidatorEncryptionManifest(board, [attest(first), attest(second)]);
  const profile: Profile = {
    entityId: ENTITY_ID,
    name: 'Multisig destination',
    avatar: '',
    bio: '',
    website: '',
    lastUpdated: 1,
    runtimeId: first.signer,
    runtimeEncPubKey: first.encryptionPublicKey,
    publicAccounts: [],
    wsUrl: null,
    relays: [],
    metadata: {
      isHub: false,
      routingFeePPM: 1,
      baseFee: 0n,
      board: {
        threshold: 2,
        validators: [first, second].map((entry) => ({
          signer: entry.signer,
          signerId: entry.signerId,
          publicKey: entry.publicKey,
          weight: entry.weight,
        })),
        encryptionAttestations: [...manifest.attestations],
      },
    },
    accounts: [],
  };
  const profileHash = computeProfileHash(profile);
  profile.metadata.profileHanko = await buildQuorumHanko(
    {} as Env,
    ENTITY_ID,
    profileHash,
    [first, second].map((validator) => ({
      signerId: validator.signer,
      signature: signDigest(validator.privateKey, profileHash),
    })),
    {
      threshold: 2n,
      validators: [first.signer, second.signer],
      shares: { [first.signer]: 1n, [second.signer]: 1n },
    },
  );
  const signingEnv = { runtimeSeed: 'multisig-profile-route' } as Env;
  registerSignerKey(signingEnv, first.signerId, first.privateKey);
  return signProfileRuntimeRoute(signingEnv, profile, first.signerId);
};

const certifiedSenderGossipProfile = async (): Promise<Profile> => {
  const encryptionPublicKey = pubKeyToHex(SENDER_ENCRYPTION.publicKey);
  const attestationBody = {
    version: 'xln:validator-encryption-key:v1' as const,
    entityId: SENDER_ID,
    signerId: SENDER_SIGNER,
    signer: SENDER_SIGNER,
    publicKey: SENDER_PUBLIC_KEY,
    weight: 1,
    encryptionPublicKey,
  };
  const attestation = {
    ...attestationBody,
    signature: signDigest(
      SENDER_PRIVATE_KEY,
      computeValidatorEncryptionAttestationDigest(attestationBody),
    ),
  };
  const profile: Profile = {
    entityId: SENDER_ID,
    name: 'Payment sender',
    avatar: '',
    bio: '',
    website: '',
    lastUpdated: 1,
    runtimeId: SENDER_SIGNER,
    runtimeEncPubKey: encryptionPublicKey,
    publicAccounts: [],
    wsUrl: null,
    relays: [],
    metadata: {
      isHub: false,
      routingFeePPM: 1,
      baseFee: 0n,
      board: {
        threshold: 1,
        validators: [{
          signer: SENDER_SIGNER,
          signerId: SENDER_SIGNER,
          publicKey: SENDER_PUBLIC_KEY,
          weight: 1,
        }],
        encryptionAttestations: [attestation],
      },
    },
    accounts: [],
  };
  const profileHash = computeProfileHash(profile);
  profile.metadata.profileHanko = await buildQuorumHanko(
    {} as Env,
    SENDER_ID,
    profileHash,
    [{ signerId: SENDER_SIGNER, signature: signDigest(SENDER_PRIVATE_KEY, profileHash) }],
    { threshold: 1n, validators: [SENDER_SIGNER], shares: { [SENDER_SIGNER]: 1n } },
  );
  const signingEnv = { runtimeSeed: 'sender-profile-route' } as Env;
  registerSignerKey(signingEnv, SENDER_SIGNER, SENDER_PRIVATE_KEY);
  return signProfileRuntimeRoute(signingEnv, profile, SENDER_SIGNER);
};

const certifiedSingleSignerHubProfile = async (nextHopId: string): Promise<Profile> => {
  const validator = signingFixture('htlc-intermediary-runtime', 'hub-validator');
  const entityId = generateLazyEntityId([{ name: validator.signer, weight: 1 }], 1n).toLowerCase();
  const encryption = deriveEncryptionKeyPair(`${hex(validator.privateKey)}:${entityId}:htlc-v1`);
  const attestationBody = {
    version: 'xln:validator-encryption-key:v1' as const,
    entityId,
    signerId: validator.signerId,
    signer: validator.signer,
    publicKey: validator.publicKey,
    weight: 1,
    encryptionPublicKey: pubKeyToHex(encryption.publicKey),
  };
  const attestation = {
    ...attestationBody,
    signature: signDigest(validator.privateKey, computeValidatorEncryptionAttestationDigest(attestationBody)),
  };
  const profile: Profile = {
    entityId,
    name: 'Certified intermediary',
    avatar: '',
    bio: '',
    website: '',
    lastUpdated: 1,
    runtimeId: validator.signer,
    runtimeEncPubKey: attestation.encryptionPublicKey,
    publicAccounts: [nextHopId],
    wsUrl: null,
    relays: [],
    metadata: {
      isHub: true,
      routingFeePPM: 100_000,
      baseFee: 2n,
      board: {
        threshold: 1,
        validators: [{
          signer: validator.signer,
          signerId: validator.signerId,
          publicKey: validator.publicKey,
          weight: 1,
        }],
        encryptionAttestations: [attestation],
      },
    },
    accounts: [{
      counterpartyId: nextHopId,
      tokenCapacities: { '1': { outCapacity: '1000', inCapacity: '1000' } },
    }],
  };
  const profileHash = computeProfileHash(profile);
  profile.metadata.profileHanko = await buildQuorumHanko(
    {} as Env,
    entityId,
    profileHash,
    [{ signerId: validator.signer, signature: signDigest(validator.privateKey, profileHash) }],
    { threshold: 1n, validators: [validator.signer], shares: { [validator.signer]: 1n } },
  );
  const signingEnv = { runtimeSeed: 'single-hub-profile-route' } as Env;
  registerSignerKey(signingEnv, validator.signerId, validator.privateKey);
  return signProfileRuntimeRoute(signingEnv, profile, validator.signerId);
};

const certifiedProcessSourceProfile = async (
  entityId: string,
  validator: ReturnType<typeof signingFixture>,
  encryptionPublicKey: string,
): Promise<Profile> => {
  const body = {
    version: 'xln:validator-encryption-key:v1' as const,
    entityId,
    signerId: validator.signerId,
    signer: validator.signer,
    publicKey: validator.publicKey,
    weight: 1,
    encryptionPublicKey,
  };
  const attestation = {
    ...body,
    signature: signDigest(validator.privateKey, computeValidatorEncryptionAttestationDigest(body)),
  };
  const profile: Profile = {
    entityId,
    name: 'Process payment sender',
    avatar: '', bio: '', website: '', lastUpdated: 1,
    runtimeId: validator.signer,
    runtimeEncPubKey: encryptionPublicKey,
    publicAccounts: [], wsUrl: null, relays: [], accounts: [],
    metadata: {
      isHub: false,
      routingFeePPM: 1,
      baseFee: 0n,
      board: {
        threshold: 1,
        validators: [{
          signer: validator.signer,
          signerId: validator.signerId,
          publicKey: validator.publicKey,
          weight: 1,
        }],
        encryptionAttestations: [attestation],
      },
    },
  };
  const profileHash = computeProfileHash(profile);
  profile.metadata.profileHanko = await buildQuorumHanko(
    {} as Env,
    entityId,
    profileHash,
    [{ signerId: validator.signer, signature: signDigest(validator.privateKey, profileHash) }],
    { threshold: 1n, validators: [validator.signer], shares: { [validator.signer]: 1n } },
  );
  const signingEnv = { runtimeSeed: 'process-source-profile-route' } as Env;
  registerSignerKey(signingEnv, validator.signerId, validator.privateKey);
  return signProfileRuntimeRoute(signingEnv, profile, validator.signerId);
};

describe('multisig HTLC validator encryption', () => {
  test('preserves numeric board aliases through signed manifest persistence and fresh restore', () => {
    const creationEnv = createEmptyEnv('numeric-alias-manifest-creation');
    const proposerPrivateKey = deriveSignerKeySync(creationEnv.runtimeSeed!, '1');
    const proposer = deriveSignerAddressSync(creationEnv.runtimeSeed!, '1').toLowerCase();
    registerSignerKey(creationEnv, proposer, proposerPrivateKey);
    const validators = [proposer, '2'] as const;
    const signerAddresses = [
      proposer,
      deriveSignerAddressSync(creationEnv.runtimeSeed!, '2').toLowerCase(),
    ];
    const entityId = generateLazyEntityId([...validators], 2n, creationEnv).toLowerCase();
    const state = certificationState();
    state.entityId = entityId;
    state.config = {
      mode: 'proposer-based',
      threshold: 2n,
      validators: [...validators],
      shares: { [proposer]: 1n, '2': 1n },
    };

    for (const signerId of validators) {
      const keys = deriveLocalEntityCryptoKeys(creationEnv, entityId, signerId);
      creationEnv.eReplicas.set(`${entityId}:${signerId}`, {
        entityId,
        signerId,
        state: {
          ...structuredClone(state),
          entityEncPubKey: keys.publicKey,
          entityEncPrivKey: keys.privateKey,
        },
        mempool: [],
        isProposer: signerId === proposer,
        hankoWitness: new Map(),
      });
    }

    collectLocalProfileEncryptionAnnouncements(creationEnv, new Set([entityId]));
    const manifest = requireProfileEncryptionManifest(creationEnv, state);
    expect(manifest.attestations.map((attestation) => attestation.signerId)).toEqual([...validators]);
    expect(manifest.attestations.map((attestation) => attestation.signer)).toEqual(signerAddresses);

    const persisted = structuredClone(state);
    persisted.profileEncryptionManifest = structuredClone(manifest);
    const persistedCore = structuredClone(projectEntityCoreDoc(persisted));
    clearSignerKeys(creationEnv);
    const restored = validateEntityState(hydrateEntityStateFromStorage({
      core: persistedCore,
      accounts: new Map(),
      books: new Map(),
    }));
    expect(restored.profileEncryptionManifest).toEqual(manifest);
  });

  test('merges independently signed validator key attestations into one complete canonical manifest', () => {
    const manifest = requireCompleteValidatorEncryptionManifest(board, [attest(second), attest(first)]);
    const canonicalValidators = [first, second].sort((left, right) => left.signer.localeCompare(right.signer));
    expect(manifest.attestations.map((entry) => entry.signerId))
      .toEqual(canonicalValidators.map((entry) => entry.signer));
    expect(manifest.attestations.map((entry) => entry.encryptionPublicKey))
      .toEqual(canonicalValidators.map((entry) => entry.encryptionPublicKey));
    expect(manifest.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('consensus replay canonicalizes the full manifest and independently derives the profile secondary hash', () => {
    const env = { eReplicas: new Map() } as unknown as Env;
    const state = certificationState();
    const result = handleCertifyProfileEntityTx(env, state, {
      type: 'certifyProfile',
      data: { encryptionAttestations: [attest(second), attest(first)] },
    });
    const stored = result.newState.profileEncryptionManifest;
    expect(stored?.attestations.map((entry) => entry.signerId))
      .toEqual([first.signerId, second.signerId].sort());
    expect(validateEntityState(result.newState).profileEncryptionManifest?.hash).toBe(stored?.hash);
    const descriptorBoard = {
      threshold: stored!.threshold,
      validators: stored!.attestations.map((entry) => ({
        signer: entry.signer,
        signerId: entry.signerId,
        publicKey: entry.publicKey,
        weight: entry.weight,
      })),
      encryptionAttestations: [...stored!.attestations],
    };
    expect(result.hashesToSign).toEqual([{
      hash: computeEntityProfileDescriptorHash(
        buildEntityProfileDescriptor(result.newState, descriptorBoard),
      ),
      type: 'profile',
      context: `profile:${stored!.hash}`,
    }]);
    expect(() => handleCertifyProfileEntityTx(env, state, {
      type: 'certifyProfile',
      data: { encryptionAttestations: [attest(first)] },
    })).toThrow('VALIDATOR_ENCRYPTION_MANIFEST_INCOMPLETE');
  });

  test('restored certified manifest resolves alias-configured validators without local key cache', () => {
    const aliases = ['1', '2'] as const;
    const aliasedBoard: ValidatorEncryptionBoard = {
      entityId: ENTITY_ID,
      threshold: 2,
      validators: [first, second].map((validator, index) => ({
        signerId: aliases[index]!,
        signer: validator.signer,
        publicKey: validator.publicKey,
        weight: validator.weight,
      })),
    };
    const aliasAttestations = [first, second].map((validator, index) => {
      const body = {
        version: 'xln:validator-encryption-key:v1' as const,
        entityId: ENTITY_ID,
        signerId: aliases[index]!,
        signer: validator.signer,
        publicKey: validator.publicKey,
        weight: validator.weight,
        encryptionPublicKey: validator.encryptionPublicKey,
      };
      return {
        ...body,
        signature: signDigest(validator.privateKey, computeValidatorEncryptionAttestationDigest(body)),
      };
    });
    const manifest = requireCompleteValidatorEncryptionManifest(aliasedBoard, aliasAttestations);
    const state = certificationState();
    state.config.validators = [...aliases];
    state.config.shares = { '1': 1n, '2': 1n };
    state.profileEncryptionManifest = manifest;

    const profile = buildEntityProfile(state, 1, {
      getSignerAddress: () => null,
      getSignerPublicKeyHex: () => null,
      getValidatorEncryptionAttestations: () => [],
    });

    expect(profile.metadata.board.validators.map((validator) => validator.signerId))
      .toEqual(['1', '2']);
    expect(profile.metadata.board.validators.map((validator) => validator.publicKey))
      .toEqual([first.publicKey, second.publicKey]);
  });

  test('accepts a validly signed numeric-alias profile with independently verified alias-to-EOA bindings', async () => {
    const aliases = ['1', '2'] as const;
    const aliasedValidators = [first, second].map((validator, index) => ({
      signer: validator.signer,
      signerId: aliases[index]!,
      publicKey: validator.publicKey,
      weight: validator.weight,
    }));
    const aliasedAttestations = [first, second].map((validator, index) => {
      const body = {
        version: 'xln:validator-encryption-key:v1' as const,
        entityId: ENTITY_ID,
        signerId: aliases[index]!,
        signer: validator.signer,
        publicKey: validator.publicKey,
        weight: validator.weight,
        encryptionPublicKey: validator.encryptionPublicKey,
      };
      return {
        ...body,
        signature: signDigest(validator.privateKey, computeValidatorEncryptionAttestationDigest(body)),
      };
    });
    const profile: Profile = {
      entityId: ENTITY_ID,
      name: 'Numeric alias profile',
      avatar: '',
      bio: '',
      website: '',
      lastUpdated: 1,
      runtimeId: first.signer,
      runtimeEncPubKey: first.encryptionPublicKey,
      runtimeSignerId: aliases[0],
      publicAccounts: [],
      wsUrl: null,
      relays: [],
      metadata: {
        isHub: false,
        routingFeePPM: 1,
        baseFee: 0n,
        board: {
          threshold: 2,
          validators: aliasedValidators,
          encryptionAttestations: aliasedAttestations,
        },
      },
      accounts: [],
    };
    // Independent legacy codec: cryptographic validity is proved below without
    // calling the production profile parser that is expected to reject it.
    const profileHash = computeEntityProfileDescriptorHash(profileToEntityProfileDescriptor(profile));
    profile.metadata.profileHanko = await buildQuorumHanko(
      {} as Env,
      ENTITY_ID,
      profileHash,
      [first, second].map((validator) => ({
        signerId: validator.signer,
        signature: signDigest(validator.privateKey, profileHash),
      })),
      {
        threshold: 2n,
        validators: [first.signer, second.signer],
        shares: { [first.signer]: 1n, [second.signer]: 1n },
      },
    );
    const routeHash = keccak256(new TextEncoder().encode(serializeTaggedJson({
      domain: 'xln-profile-runtime-route-v1',
      profileHash,
      entityId: profile.entityId,
      runtimeId: profile.runtimeId,
      runtimeSignerId: profile.runtimeSignerId,
      runtimeEncPubKey: profile.runtimeEncPubKey,
      lastUpdated: profile.lastUpdated,
      wsUrl: profile.wsUrl,
      relays: profile.relays,
      mirrors: [],
    })));
    profile.runtimeSignature = signDigest(first.privateKey, routeHash);
    expect((await verifyHankoForHash(
      profile.metadata.profileHanko!,
      profileHash,
      ENTITY_ID,
    )).valid).toBe(true);
    expect(recoverAddress(routeHash, profile.runtimeSignature).toLowerCase()).toBe(first.signer);
    expect(await verifyProfileSignature({ ...profile, runtimeSignerId: aliases[1] }))
      .toMatchObject({ valid: false, reason: 'runtime_signature_invalid', signerId: aliases[1] });

    const forgedBinding = structuredClone(profile);
    forgedBinding.metadata.board.validators[0]!.signer = second.signer;
    forgedBinding.metadata.board.validators[0]!.publicKey = second.publicKey;
    expect(() => parseProfile(forgedBinding))
      .toThrow('VALIDATOR_ENCRYPTION_ATTESTATION_BOARD_IDENTITY_MISMATCH');

    const env = createEmptyEnv('numeric-alias-profile-atomicity');
    const acceptedProfiles: Profile[][] = [];
    const p2p = new RuntimeP2P({
      env,
      runtimeId: env.runtimeId!,
      onEntityInput: () => undefined,
      onGossipProfiles: (_from, accepted) => acceptedProfiles.push(accepted),
    });
    await (p2p as unknown as {
      applyIncomingProfiles: (from: string, profiles: Profile[]) => Promise<void>;
    }).applyIncomingProfiles(first.signer, [profile]);

    expect(env.gossip.getProfiles()).toEqual([expect.objectContaining({ entityId: ENTITY_ID })]);
    expect(p2p.getVerifiedRuntimeRoute(ENTITY_ID)).toEqual({
      runtimeId: first.signer,
      lastUpdated: 1,
    });
    expect(acceptedProfiles).toEqual([[expect.objectContaining({ entityId: ENTITY_ID })]]);
  });

  test('fails closed until every current board validator has authenticated a key', () => {
    expect(() => requireCompleteValidatorEncryptionManifest(board, [attest(first)]))
      .toThrow('VALIDATOR_ENCRYPTION_MANIFEST_INCOMPLETE');
  });

  test('rejects conflicting attestations for the same board validator', () => {
    const honest = attest(first);
    const conflicting = { ...honest, encryptionPublicKey: second.encryptionPublicKey };
    expect(() => mergeValidatorEncryptionAttestations(board, [honest, conflicting]))
      .toThrow('VALIDATOR_ENCRYPTION_ATTESTATION_SIGNATURE_MISMATCH');
  });

  test('rejects duplicate X25519 keys even when both board validators signed them', () => {
    const duplicatedSecond = attest({ ...second, encryptionPublicKey: first.encryptionPublicKey });
    expect(() => requireCompleteValidatorEncryptionManifest(board, [attest(first), duplicatedSecond]))
      .toThrow('VALIDATOR_ENCRYPTION_MANIFEST_DUPLICATE_PUBLIC_KEY');
  });

  test('wraps one content key only for the certified default proposer', async () => {
    const manifest = requireCompleteValidatorEncryptionManifest(board, [attest(first), attest(second)]);
    const profileCertification = await certifyManifest(manifest.hash);
    const plaintext = JSON.stringify({ nextHop: 'bob', forwardAmount: '91', innerEnvelope: 'opaque' });
    const ciphertext = await encryptForValidatorManifest(
      plaintext,
      manifest,
      profileCertification,
      CONTEXT_HASH,
      new NobleCryptoProvider(),
      first.signerId,
    );
    const firstReplay = await decryptForLocalValidator(
      ciphertext,
      board,
      first.signerId,
      first.encryptionPublicKey,
      first.encryptionPrivateKey,
      CONTEXT_HASH,
      new NobleCryptoProvider(),
    );
    expect(firstReplay).toBe(plaintext);
    await expect(decryptForLocalValidator(
      ciphertext,
      board,
      second.signerId,
      second.encryptionPublicKey,
      second.encryptionPrivateKey,
      CONTEXT_HASH,
      new NobleCryptoProvider(),
    )).rejects.toThrow('HTLC_MULTI_RECIPIENT_LOCAL_KEY_MATCH: matches=0');
    expect(ciphertext.recipients).toEqual([expect.objectContaining({ signerId: first.signerId })]);
  });

  test('rejects exact-schema sidecars and nested HTLC plaintext before consensus', async () => {
    const manifest = requireCompleteValidatorEncryptionManifest(board, [attest(first), attest(second)]);
    const ciphertext = await encryptForValidatorManifest(
      'opaque',
      manifest,
      await certifyManifest(manifest.hash),
      CONTEXT_HASH,
      new NobleCryptoProvider(),
      first.signerId,
    );
    const rejectsSidecar = (mutate: (candidate: Record<string, unknown>) => void): void => {
      const candidate = structuredClone(ciphertext) as unknown as Record<string, unknown>;
      mutate(candidate);
      expect(() => validateMultiRecipientCiphertext(
        candidate as unknown as typeof ciphertext,
        ENTITY_ID,
        CONTEXT_HASH,
      )).toThrow('HTLC_MULTI_RECIPIENT_SCHEMA_INVALID');
    };

    rejectsSidecar((candidate) => { candidate['secret'] = `0x${'11'.repeat(32)}`; });
    rejectsSidecar((candidate) => {
      (candidate['manifest'] as Record<string, unknown>)['secret'] = `0x${'22'.repeat(32)}`;
    });
    rejectsSidecar((candidate) => {
      const manifestRecord = candidate['manifest'] as { attestations: Array<Record<string, unknown>> };
      manifestRecord.attestations[0]!['secret'] = `0x${'33'.repeat(32)}`;
    });
    rejectsSidecar((candidate) => {
      const manifestRecord = candidate['manifest'] as { attestations: Array<Record<string, unknown>> };
      (manifestRecord.attestations as unknown as Record<string, unknown>)['secret'] = `0x${'34'.repeat(32)}`;
    });
    rejectsSidecar((candidate) => {
      (candidate['profileCertification'] as Record<string, unknown>)['secret'] = `0x${'44'.repeat(32)}`;
    });
    rejectsSidecar((candidate) => {
      const recipients = candidate['recipients'] as Array<Record<string, unknown>>;
      recipients[0]!['secret'] = `0x${'55'.repeat(32)}`;
    });
    rejectsSidecar((candidate) => {
      (candidate['recipients'] as unknown as Record<string, unknown>)['secret'] = `0x${'56'.repeat(32)}`;
    });

    expect(() => assertNoConsensusVisibleHtlcPaymentSecrets([{
      type: 'htlcPayment',
      data: {
        preparedEnvelope: {
          nextHop: ENTITY_ID,
          innerEnvelope: { secret: `0x${'66'.repeat(32)}` },
        },
      },
    } as never])).toThrow('HTLC_PAYMENT_SECRET_CONSENSUS_FORBIDDEN');

    const leakedFinalAdvance = {
      type: 'htlcOnionAdvance',
      data: {
        version: 1,
        proposerSignerId: first.signerId,
        inboundEntityId: SENDER_ID,
        inboundLockId: `0x${'71'.repeat(32)}`,
        encryptedLayerHash: `0x${'72'.repeat(32)}`,
        hashlock: `0x${'73'.repeat(32)}`,
        tokenId: 1,
        amount: 1n,
        timelock: 2n,
        revealBeforeHeight: 3,
        advance: { kind: 'final', secret: `0x${'74'.repeat(32)}` },
      },
    } as const;
    expect(() => assertNoConsensusVisibleHtlcPaymentSecrets([leakedFinalAdvance as never]))
      .toThrow('HTLC_PAYMENT_SECRET_CONSENSUS_FORBIDDEN');
    expect(() => validateEntityTx(leakedFinalAdvance, 'HTLC_FINAL_ADVANCE_WAL'))
      .toThrow('HTLC_FINAL_ADVANCE_WAL_DATA_FINAL_FIELDS');

  });

  test('commits an opaque final offer without paying, then only the payer can accept its exact hash', async () => {
    const senderProfile = await certifiedSenderGossipProfile();
    const descriptor = profileToEntityProfileDescriptor(senderProfile);
    const components = computeEntityProfileCertificationComponents(descriptor);
    const manifest = getValidatorEncryptionManifestFromBoard(SENDER_ID, descriptor.metadata.board);
    const secret = `0x${'9a'.repeat(32)}`;
    const lockId = `0x${'4a'.repeat(32)}`;
    const [leftEntity, rightEntity] = [SENDER_ID, ENTITY_ID].sort() as [string, string];
    const senderIsLeft = leftEntity === SENDER_ID;
    const lock = {
      lockId,
      hashlock: hashHtlcSecret(secret).toLowerCase(),
      timelock: 60_000n,
      revealBeforeHeight: 50,
      amount: 25n,
      tokenId: 1,
      senderIsLeft,
      createdHeight: 1,
      createdTimestamp: 1,
    };
    const offer = await encryptForValidatorManifest(
      'opaque-secret-offer',
      manifest,
      {
        profileHash: components.profileHash,
        routingStateHash: components.routingStateHash,
        hanko: senderProfile.metadata.profileHanko!,
      },
      htlcSecretOfferContextHash(SENDER_ID, ENTITY_ID, lock),
      new NobleCryptoProvider({ deterministicSeed: 'account-secret-offer' }),
      SENDER_SIGNER,
    );
    const delta = createDefaultDelta(1);
    if (senderIsLeft) delta.leftHold = lock.amount;
    else delta.rightHold = lock.amount;
    const account = {
      leftEntity,
      rightEntity,
      deltas: new Map([[1, delta]]),
      locks: new Map([[lockId, lock]]),
    } as unknown as AccountMachine;

    const offered = await handleHtlcResolve(
      account,
      { type: 'htlc_resolve', data: { lockId, outcome: 'offer', offer } },
      !senderIsLeft,
      2,
      2,
    );
    expect(offered.success).toBe(true);
    expect(account.locks.get(lockId)?.secretOffer).toEqual(offer);
    expect(delta.offdelta).toBe(0n);
    expect(senderIsLeft ? delta.leftHold : delta.rightHold).toBe(25n);

    const offerHash = hashEncryptedHtlcLayer(offer);
    const wrongSide = await handleHtlcResolve(
      account,
      { type: 'htlc_resolve', data: { lockId, outcome: 'secret', offerHash } },
      !senderIsLeft,
      2,
      2,
    );
    expect(wrongSide.success).toBe(false);
    expect(account.locks.has(lockId)).toBe(true);

    const accepted = await handleHtlcResolve(
      account,
      { type: 'htlc_resolve', data: { lockId, outcome: 'secret', offerHash } },
      senderIsLeft,
      2,
      2,
    );
    expect(accepted.success).toBe(true);
    expect(account.locks.has(lockId)).toBe(false);
    expect(senderIsLeft ? delta.leftHold : delta.rightHold).toBe(0n);
    expect(delta.offdelta).toBe(senderIsLeft ? -25n : 25n);
  });

  test('reveals fee-adjusted forwarded plaintext only against the exact durable Account ACK marker', async () => {
    const senderProfile = await certifiedSenderGossipProfile();
    const descriptor = profileToEntityProfileDescriptor(senderProfile);
    const components = computeEntityProfileCertificationComponents(descriptor);
    const manifest = getValidatorEncryptionManifestFromBoard(SENDER_ID, descriptor.metadata.board);
    const secret = `0x${'8b'.repeat(32)}`;
    const lock = {
      lockId: `0x${'5b'.repeat(32)}`,
      hashlock: hashHtlcSecret(secret).toLowerCase(),
      timelock: 60_000n,
      revealBeforeHeight: 50,
      amount: 7_000_000n,
      tokenId: 1,
      senderIsLeft: SENDER_ID < ENTITY_ID,
      createdHeight: 1,
      createdTimestamp: 1,
    };
    const offer = await encryptForValidatorManifest(
      'accepted-offer',
      manifest,
      {
        profileHash: components.profileHash,
        routingStateHash: components.routingStateHash,
        hanko: senderProfile.metadata.profileHanko!,
      },
      htlcSecretOfferContextHash(SENDER_ID, ENTITY_ID, lock),
      new NobleCryptoProvider({ deterministicSeed: 'accepted-offer-reveal' }),
      SENDER_SIGNER,
    );
    const frameHash = `0x${'6c'.repeat(32)}`;
    const state = senderState();
    const upstreamEntityId = `0x${'4a'.repeat(32)}`;
    state.crontabState = initCrontab();
    state.htlcRoutes.set(lock.hashlock, {
      hashlock: lock.hashlock,
      tokenId: lock.tokenId,
      amount: 7_000_007n,
      inboundEntity: upstreamEntityId,
      inboundLockId: `0x${'4b'.repeat(32)}`,
      outboundEntity: ENTITY_ID,
      outboundLockId: lock.lockId,
      pendingFee: 7n,
      acceptedOfferHash: hashEncryptedHtlcLayer(offer),
      acceptedAccountFrameHash: frameHash,
      acceptedAccountFrameHeight: 7,
      createdTimestamp: state.timestamp,
    });
    const reveal = buildHtlcOnionRevealAcceptedTx(
      state,
      ENTITY_ID,
      lock,
      offer,
      frameHash,
      7,
      secret,
    );
    const withoutAck = structuredClone(state);
    withoutAck.htlcRoutes.get(lock.hashlock)!.acceptedAccountFrameHash = `0x${'7d'.repeat(32)}`;
    await expect(validateHtlcOnionAdvanceTx({} as Env, withoutAck, reveal))
      .rejects.toThrow('HTLC_ONION_ADVANCE_REVEAL_ACK_BINDING_MISMATCH');
    const wrongNetAmount = structuredClone(reveal);
    wrongNetAmount.data.amount -= 1n;
    await expect(validateHtlcOnionAdvanceTx({} as Env, state, wrongNetAmount))
      .rejects.toThrow('HTLC_ONION_ADVANCE_REVEAL_ROUTE_BINDING_MISMATCH');
    expect(() => assertNoConsensusVisibleHtlcPaymentSecrets([reveal])).not.toThrow();
    expect(() => validateEntityTx(reveal, 'HTLC_ACCEPTED_REVEAL_WAL')).not.toThrow();

    const emitted: string[] = [];
    const applied = await handleHtlcOnionAdvance(
      { emit: (type: string) => emitted.push(type) } as unknown as Env,
      state,
      reveal,
    );
    expect(applied.newState.htlcRoutes.get(lock.hashlock)).toMatchObject({
      secret,
      secretAckPending: true,
    });
    expect(applied.newState.htlcFeesEarned).toBe(7n);
    expect(applied.mempoolOps).toEqual([{
      accountId: upstreamEntityId,
      tx: {
        type: 'htlc_resolve',
        data: { lockId: `0x${'4b'.repeat(32)}`, outcome: 'secret', secret },
      },
    }]);
    expect(emitted).not.toContain('HtlcFinalized');
  });

  test('appends the post-unlock reveal beside the certified output that carries the exact Account ACK', async () => {
    const senderProfile = await certifiedSenderGossipProfile();
    const descriptor = profileToEntityProfileDescriptor(senderProfile);
    const components = computeEntityProfileCertificationComponents(descriptor);
    const manifest = getValidatorEncryptionManifestFromBoard(SENDER_ID, descriptor.metadata.board);
    const secret = `0x${'9c'.repeat(32)}`;
    const lock = {
      lockId: `0x${'6d'.repeat(32)}`,
      hashlock: hashHtlcSecret(secret).toLowerCase(),
      timelock: 60_000n,
      revealBeforeHeight: 50,
      amount: 25n,
      tokenId: 1,
      senderIsLeft: SENDER_ID < ENTITY_ID,
      createdHeight: 1,
      createdTimestamp: 1,
    };
    const offer = await encryptBytesForValidatorManifest(
      encodeHtlcSecretOffer({ secret }),
      manifest,
      {
        profileHash: components.profileHash,
        routingStateHash: components.routingStateHash,
        hanko: senderProfile.metadata.profileHanko!,
      },
      htlcSecretOfferContextHash(SENDER_ID, ENTITY_ID, lock),
      new NobleCryptoProvider({ deterministicSeed: 'same-input-accepted-reveal' }),
      SENDER_SIGNER,
    );
    const state = senderState();
    const account = paymentAccount(SENDER_ID, ENTITY_ID);
    account.locks.set(lock.lockId, { ...lock, secretOffer: offer });
    const frameHash = `0x${'7e'.repeat(32)}`;
    account.pendingFrame = {
      ...account.currentFrame!,
      height: 7,
      timestamp: 7,
      prevFrameHash: account.currentFrame!.stateHash,
      stateHash: frameHash,
      accountStateRoot: `0x${'8f'.repeat(32)}`,
      accountTxs: [{
        type: 'htlc_resolve',
        data: { lockId: lock.lockId, outcome: 'secret', offerHash: hashEncryptedHtlcLayer(offer) },
      }],
      byLeft: lock.senderIsLeft,
    };
    state.accounts.set(ENTITY_ID, account);
    const env = createEmptyEnv('same-input-accepted-reveal');
    registerSignerKey(env, SENDER_SIGNER, SENDER_PRIVATE_KEY);
    const replica = {
      entityId: SENDER_ID,
      signerId: SENDER_SIGNER,
      isProposer: true,
      mempool: [],
      state,
      hankoWitness: new Map(),
    };
    const sourceConfig = {
      threshold: 2n,
      validators: [first.signer, second.signer],
      shares: { [first.signer]: 1n, [second.signer]: 1n },
    };
    const sourceHanko = (hash: string) => buildQuorumHanko(
      env,
      ENTITY_ID,
      hash,
      [first, second].map((validator) => ({
        signerId: validator.signer,
        signature: signDigest(validator.privateKey, hash),
      })),
      sourceConfig,
    );
    const accountInput = {
      type: 'accountInput' as const,
      data: {
        kind: 'ack' as const,
        fromEntityId: ENTITY_ID,
        toEntityId: SENDER_ID,
        ack: { height: 7, frameHash, frameHanko: await sourceHanko(frameHash) },
      },
    };
    const semanticHash = hashCertifiedEntityOutputSemantic(
      ENTITY_ID,
      SENDER_ID,
      'account-frame',
      7n,
      [accountInput],
    );
    const origin = buildConsensusOutputOrigin(
      ENTITY_ID,
      11,
      `0x${'91'.repeat(32)}`,
      0,
      { lane: 'account-frame', sequence: 7n, semanticHash },
    );
    const outputHash = hashCertifiedEntityOutput(origin, SENDER_ID, [accountInput]);
    const certifiedOutput = {
      type: 'consensusOutput' as const,
      data: {
        origin,
        outputHanko: await sourceHanko(outputHash),
        targetEntityId: SENDER_ID,
        entityTxs: [accountInput],
      },
    };
    const enriched = await appendDefaultProposerAcceptedHtlcReveals(env, replica, [certifiedOutput]);
    expect(enriched).toHaveLength(2);
    expect(enriched[0]).toEqual(certifiedOutput);
    expect(enriched[1]).toMatchObject({
      type: 'htlcOnionAdvance',
      data: {
        inboundLockId: lock.lockId,
        advance: { kind: 'revealAccepted', secret, accountFrameHash: frameHash, accountFrameHeight: 7 },
      },
    });

    const bare = await appendDefaultProposerAcceptedHtlcReveals(env, replica, [accountInput]);
    expect(bare).toEqual([accountInput]);
    const forgedOutput = structuredClone(certifiedOutput);
    forgedOutput.data.outputHanko = '0x01';
    await expect(appendDefaultProposerAcceptedHtlcReveals(env, replica, [forgedOutput]))
      .rejects.toThrow('CONSENSUS_OUTPUT_HANKO_INVALID');
  });

  test('seals once with proposer-only secret and validates frozen public admission data without gossip', async () => {
    const profile = await certifiedGossipProfile();
    const senderProfile = await certifiedSenderGossipProfile();
    const state = senderState();
    const env = {
      height: 10,
      timestamp: state.timestamp,
      runtimeSeed: 'htlc-admission-test',
      eReplicas: new Map(),
      gossip: {
        getProfiles: () => [senderProfile, profile],
        getNetworkGraph: () => ({ findPaths: async () => [] }),
      },
    } as unknown as Env;
    const secret = `0x${'ad'.repeat(32)}`;
    const raw = withDeterministicHtlcTestSecret({
      type: 'htlcPayment' as const,
      data: {
        targetEntityId: ENTITY_ID,
        tokenId: 1,
        amount: 25n,
        route: [SENDER_ID, ENTITY_ID],
      },
    }, secret);
    const firstPrepared = await prepareHtlcPaymentEntityTx(env, state, raw);
    const secondPrepared = await prepareHtlcPaymentEntityTx(env, state, raw);
    expect(raw.data).not.toHaveProperty('preparedEnvelope');
    expect(firstPrepared.data).not.toHaveProperty('secret');
    expect(firstPrepared.data.preparedAtEntityHeight).toBe(state.height);
    expect(firstPrepared.data.preparedAtJHeight).toBe(state.lastFinalizedJHeight);
    expect(firstPrepared.data.preparedEnvelope).toEqual(secondPrepared.data.preparedEnvelope);
    await expect(prepareHtlcPaymentEntityTx(env, state, structuredClone(raw)))
      .rejects.toThrow('HTLC_PAYMENT_HASHLOCK_WITHOUT_SECRET');
    await expect(prepareHtlcPaymentEntityTx(env, state, {
      type: 'htlcPayment',
      data: { ...raw.data, secret } as never,
    })).rejects.toThrow('HTLC_PAYMENT_EXPLICIT_SECRET_FORBIDDEN');
    expect(() => buildCollectiveEntityProposalTx('sender', [firstPrepared])).not.toThrow();
    env.gossip = undefined;
    const firstReplay = await validatePreparedHtlcPayment(env, structuredClone(state), firstPrepared);
    const delayedState = structuredClone(state);
    delayedState.height += 1;
    delayedState.timestamp += 100;
    const secondReplay = await validatePreparedHtlcPayment(env, delayedState, firstPrepared);
    expect(firstReplay).toEqual(secondReplay);
    expect(firstReplay.senderLockAmount).toBe(25n);

    const ciphertext = (firstPrepared.data.preparedEnvelope as { innerEnvelope: object }).innerEnvelope;
    const tampered = {
      ...firstPrepared,
      data: {
        ...firstPrepared.data,
        preparedEnvelope: {
          ...(firstPrepared.data.preparedEnvelope as object),
          innerEnvelope: { ...ciphertext, contextHash: `0x${'ee'.repeat(32)}` },
        },
      },
    };
    await expect(validatePreparedHtlcPayment(env, state, tampered)).rejects.toThrow(
      'HTLC_ENCRYPTION_CONTEXT_MISMATCH',
    );
    const ciphertextTamper = structuredClone(firstPrepared);
    const ciphertextBundle = (ciphertextTamper.data.preparedEnvelope as {
      innerEnvelope: { ciphertext: string };
    }).innerEnvelope;
    ciphertextBundle.ciphertext = flipBase64Byte(ciphertextBundle.ciphertext);
    await expect(validatePreparedHtlcPayment(env, state, ciphertextTamper)).resolves.toMatchObject({
      hashlock: firstReplay.hashlock,
      senderLockAmount: firstReplay.senderLockAmount,
    });
    const wrappedKeyTamper = structuredClone(firstPrepared);
    const wrappedKeyBundle = (wrappedKeyTamper.data.preparedEnvelope as {
      innerEnvelope: { recipients: Array<{ wrappedKey: string }> };
    }).innerEnvelope;
    wrappedKeyBundle.recipients[0]!.wrappedKey = flipBase64Byte(wrappedKeyBundle.recipients[0]!.wrappedKey);
    await expect(validatePreparedHtlcPayment(env, state, wrappedKeyTamper)).resolves.toMatchObject({
      hashlock: firstReplay.hashlock,
      senderLockAmount: firstReplay.senderLockAmount,
    });
  });

  test('generates a proposer secret only at raw ingress and publishes only its hashlock', async () => {
    const profile = await certifiedGossipProfile();
    const senderProfile = await certifiedSenderGossipProfile();
    const state = senderState();
    const env = {
      height: 10,
      timestamp: state.timestamp,
      runtimeSeed: 'htlc-random-secret-ingress',
      eReplicas: new Map(),
      gossip: {
        getProfiles: () => [senderProfile, profile],
        getNetworkGraph: () => ({ findPaths: async () => [] }),
      },
    } as unknown as Env;
    const prepared = await prepareHtlcPaymentEntityTx(env, state, {
      type: 'htlcPayment',
      data: {
        targetEntityId: ENTITY_ID,
        tokenId: 1,
        amount: 25n,
        route: [SENDER_ID, ENTITY_ID],
      },
    });
    expect(prepared.data).not.toHaveProperty('secret');
    expect(prepared.data.hashlock).toMatch(/^0x[0-9a-f]{64}$/);
    await expect(validatePreparedHtlcPayment({ ...env, gossip: undefined } as Env, state, prepared)).resolves.toBeDefined();
    await expect(prepareHtlcPaymentEntityTx(env, state, {
      type: 'htlcPayment',
      data: {
        targetEntityId: ENTITY_ID,
        tokenId: 1,
        amount: 25n,
        route: [SENDER_ID, ENTITY_ID],
        hashlock: `0x${'12'.repeat(32)}`,
      },
    })).rejects.toThrow('HTLC_PAYMENT_HASHLOCK_WITHOUT_SECRET');
  });

  test('reports expected insufficient capacity as info without warning or error output', async () => {
    const profile = await certifiedGossipProfile();
    const senderProfile = await certifiedSenderGossipProfile();
    const state = senderState();
    state.accounts.set(ENTITY_ID, paymentAccount(SENDER_ID, ENTITY_ID));
    const emitted: Array<{ eventName: string; data: Record<string, unknown> }> = [];
    const env = {
      height: 10,
      timestamp: state.timestamp,
      runtimeSeed: 'htlc-capacity-severity-test',
      eReplicas: new Map(),
      gossip: {
        getProfiles: () => [senderProfile, profile],
        getNetworkGraph: () => ({ findPaths: async () => [] }),
      },
      emit: (eventName: string, data: Record<string, unknown>) => emitted.push({ eventName, data }),
    } as unknown as Env;
    const prepared = await prepareHtlcPaymentEntityTx(env, state, withDeterministicHtlcTestSecret({
      type: 'htlcPayment',
      data: {
        targetEntityId: ENTITY_ID,
        tokenId: 1,
        amount: 1_001n,
        route: [SENDER_ID, ENTITY_ID],
      },
    }, `0x${'bc'.repeat(32)}`));
    env.gossip = undefined;

    const priorLevel = process.env['XLN_LOG_LEVEL'];
    process.env['XLN_LOG_LEVEL'] = 'trace';
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await handleHtlcPayment(state, prepared, env);
      expect(result.mempoolOps).toHaveLength(0);
      expect(emitted).toEqual([]);
      expect(result.newState.messages.at(-1)).toBe('❌ HTLC payment failed: insufficient capacity');
      expect(warn).toHaveBeenCalledTimes(0);
      expect(error).toHaveBeenCalledTimes(0);
      expect(log.mock.calls.some(([line]) =>
        String(line).includes('[INFO][entity.htlc] rejected') &&
        String(line).includes('insufficient-capacity')
      )).toBe(true);
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      if (priorLevel === undefined) delete process.env['XLN_LOG_LEVEL'];
      else process.env['XLN_LOG_LEVEL'] = priorLevel;
    }
  });

  test('emits a public HTLC initiation only after queuing the exact account lock', async () => {
    const profile = await certifiedGossipProfile();
    const senderProfile = await certifiedSenderGossipProfile();
    const state = senderState();
    state.accounts.set(ENTITY_ID, paymentAccount(SENDER_ID, ENTITY_ID));
    const emitted: Array<{ eventName: string; data: Record<string, unknown> }> = [];
    const env = {
      height: 10,
      timestamp: state.timestamp,
      runtimeSeed: 'htlc-initiation-event-test',
      eReplicas: new Map(),
      quietRuntimeLogs: true,
      gossip: {
        getProfiles: () => [senderProfile, profile],
        getNetworkGraph: () => ({ findPaths: async () => [] }),
      },
      emit: (eventName: string, data: Record<string, unknown>) => emitted.push({ eventName, data }),
    } as unknown as Env;
    const prepared = await prepareHtlcPaymentEntityTx(env, state, withDeterministicHtlcTestSecret({
      type: 'htlcPayment',
      data: {
        targetEntityId: ENTITY_ID,
        tokenId: 1,
        amount: 25n,
        route: [SENDER_ID, ENTITY_ID],
        description: 'custody-withdrawal:test',
      },
    }, `0x${'bd'.repeat(32)}`));
    env.gossip = undefined;

    const result = await handleHtlcPayment(state, prepared, env);
    expect(result.mempoolOps).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      eventName: 'HtlcInitiated',
      data: {
        entityId: SENDER_ID,
        fromEntity: SENDER_ID,
        toEntity: ENTITY_ID,
        tokenId: 1,
        amount: '25',
        hashlock: prepared.data.hashlock,
        lockId: prepared.data.preparedLockId,
        route: [SENDER_ID, ENTITY_ID],
        description: 'custody-withdrawal:test',
      },
    });
    expect(emitted[0]?.data).not.toHaveProperty('secret');
  });

  test('rejects a partial prepared payload before consensus admission', async () => {
    const state = senderState();
    const env = {
      height: 10,
      timestamp: state.timestamp,
      eReplicas: new Map([[`${SENDER_ID}:sender`, {
        entityId: SENDER_ID,
        signerId: 'sender',
        state,
      }]]),
    } as unknown as Env;
    await expect(prepareHtlcPaymentEntityInputs(env, [{
      entityId: SENDER_ID,
      signerId: 'sender',
      entityTxs: [{
        type: 'htlcPayment',
        data: {
          targetEntityId: ENTITY_ID,
          tokenId: 1,
          amount: 1n,
          route: [SENDER_ID, ENTITY_ID],
          secret: `0x${'ac'.repeat(32)}`,
          preparedLockId: `0x${'12'.repeat(32)}`,
        },
      }],
    }])).rejects.toThrow('HTLC_PAYMENT_PREPARED_PAYLOAD_PARTIAL');
  });

  test('seals raw process ingress and lets two cold restores replay the prepared frame without gossip', async () => {
    const destination = await certifiedGossipProfile();
    const source = signingFixture('htlc-process-source', 'source-validator');
    const sourceEntityId = generateLazyEntityId([source.signer], 1n).toLowerCase();
    const sourceEncryption = deriveEncryptionKeyPair(`${hex(source.privateKey)}:${sourceEntityId}:htlc-v1`);
    const initialState = processSenderState(
      sourceEntityId,
      source.signer,
      pubKeyToHex(sourceEncryption.publicKey),
      hex(sourceEncryption.privateKey),
    );
    initialState.lastFinalizedJHeight = 41;
    initialState.accounts.set(destination.entityId, paymentAccount(sourceEntityId, destination.entityId));
    for (const task of initialState.crontabState?.tasks.values() ?? []) task.enabled = false;

    const env = createEmptyEnv('multisig-htlc-process-ingress');
    registerSignerKey(env, source.signer, source.privateKey);
    installProcessJurisdictionReplica(env);
    env.dbNamespace = `${env.runtimeId}-multisig-htlc-${process.pid}`;
    env.scenarioMode = true;
    env.timestamp = initialState.timestamp;
    env.quietRuntimeLogs = true;
    env.eReplicas.set(`${sourceEntityId}:${source.signer}`, {
      entityId: sourceEntityId,
      signerId: source.signer,
      isProposer: true,
      mempool: [],
      state: structuredClone(initialState),
      hankoWitness: new Map(),
    });
    await anchorManualGenesisReplica(env, initialState);
    const sourceProfile = await certifiedProcessSourceProfile(
      sourceEntityId,
      source,
      pubKeyToHex(sourceEncryption.publicKey),
    );
    env.gossip.announce(sourceProfile);
    env.gossip.announce(destination);

    const rawSecret = `0x${'cd'.repeat(32)}`;
    const rawPayment = withDeterministicHtlcTestSecret({
      type: 'htlcPayment' as const,
      data: {
        targetEntityId: destination.entityId,
        tokenId: 1,
        amount: 25n,
        route: [sourceEntityId, destination.entityId],
        description: 'process ingress replay',
      },
    }, rawSecret);
    await processRuntime(env, [{
      entityId: sourceEntityId,
      signerId: source.signer,
      entityTxs: [rawPayment],
    }]);
    expect(rawPayment.data).not.toHaveProperty('preparedEnvelope');

    const durablePayment = env.history
      .flatMap((frame) => frame.runtimeInput.entityInputs)
      .flatMap((input) => input.entityTxs ?? [])
      .find((tx) => tx.type === 'htlcPayment');
    if (!durablePayment || durablePayment.type !== 'htlcPayment') {
      throw new Error('HTLC_PROCESS_DURABLE_PREPARED_FRAME_MISSING');
    }
    expect(durablePayment.data.preparedEnvelope).toBeDefined();
    expect(durablePayment.data).not.toHaveProperty('secret');
    expect(serializeTaggedJson(env.history)).not.toContain(rawSecret);
    expect(serializeTaggedJson(env.eReplicas)).not.toContain(rawSecret);
    expect(durablePayment.data.preparedRouteProfiles).toHaveLength(1);
    expect(durablePayment.data.startedAtMs).toBe(1_000);
    const uiLikePayment = {
      type: 'htlcPayment' as const,
      data: {
        targetEntityId: destination.entityId,
        tokenId: 1,
        amount: 24n,
        route: [sourceEntityId, destination.entityId],
        description: 'wallet intent without preimage',
      },
    };
    await processRuntime(env, [{
      entityId: sourceEntityId,
      signerId: source.signer,
      entityTxs: [uiLikePayment],
    }]);
    const durablePayments = env.history
      .flatMap((frame) => frame.runtimeInput.entityInputs)
      .flatMap((input) => input.entityTxs ?? [])
      .filter((tx): tx is Extract<typeof tx, { type: 'htlcPayment' }> => tx.type === 'htlcPayment');
    const uiLikeDurablePayment = durablePayments.at(-1);
    expect(uiLikePayment.data).not.toHaveProperty('secret');
    expect(uiLikeDurablePayment?.data).not.toHaveProperty('secret');
    expect(uiLikeDurablePayment?.data.hashlock).toMatch(/^0x[0-9a-f]{64}$/);
    expect(uiLikeDurablePayment?.data.hashlock).not.toBe(durablePayment.data.hashlock);
    const signedPaymentProposal = signedEntityCommandTx(buildSignedEntityCommand(
      env,
      initialState,
      source.signer,
      [buildCollectiveEntityProposalTx(source.signer, [durablePayment])],
    ));
    expect(serializeTaggedJson(signedPaymentProposal)).not.toContain(rawSecret);

    const replay = async (seed: string) => {
      const validatorEnv = createEmptyEnv(seed);
      registerSignerKey(validatorEnv, source.signer, source.privateKey);
      installProcessJurisdictionReplica(validatorEnv);
      validatorEnv.scenarioMode = true;
      validatorEnv.timestamp = 1_000;
      validatorEnv.quietRuntimeLogs = true;
      validatorEnv.gossip.setProfiles([]);
      validatorEnv.eReplicas.set(`${sourceEntityId}:${source.signer}`, {
        entityId: sourceEntityId,
        signerId: source.signer,
        isProposer: true,
        mempool: [],
        state: structuredClone(initialState),
        hankoWitness: new Map(),
      });
      return applyEntityFrame(
        validatorEnv,
        structuredClone(initialState),
        [structuredClone(signedPaymentProposal)],
        1_000,
      );
    };
    const [firstReplay, secondReplay] = await Promise.all([
      replay('multisig-htlc-validator-replay-a'),
      replay('multisig-htlc-validator-replay-b'),
    ]);
    expect(serializeTaggedJson(firstReplay.deterministicState)).toBe(
      serializeTaggedJson(secondReplay.deterministicState),
    );
    const route = firstReplay.deterministicState.htlcRoutes.values().next().value;
    expect(route?.amount).toBe(25n);
    const queued = firstReplay.deterministicState.accounts.get(destination.entityId)?.mempool;
    expect(queued).toHaveLength(1);
    expect(queued?.[0]?.type).toBe('htlc_lock');
    const proposedAccount = firstReplay.newState.accounts.get(destination.entityId);
    expect(proposedAccount?.pendingFrame?.accountTxs[0]?.type).toBe('htlc_lock');
    expect(proposedAccount?.pendingAccountInput?.kind).toBe('frame');
    expect(proposedAccount?.currentFrameHanko).toMatch(/^0x[0-9a-f]+$/);
    expect(firstReplay.outputs).toHaveLength(1);
    expect(serializeTaggedJson(firstReplay.outputs)).toBe(serializeTaggedJson(secondReplay.outputs));
    expect(firstReplay.outputs[0]?.entityId).toBe(destination.entityId);
    expect(firstReplay.outputs[0]?.signerId).toBe(first.signerId);
    expect(firstReplay.outputs[0]?.entityTxs?.[0]?.type).toBe('accountInput');
    expect(firstReplay.outputs.some((output) => output.entityTxs?.length === 0)).toBe(false);
    clearSignerKeys(env);
  });

  test('certifies and announces a local profile without P2P before it becomes routable', async () => {
    const runtimeSeed = 'local-profile-lifecycle-no-p2p';
    const signerId = deriveSignerAddressSync(runtimeSeed, '3').toLowerCase();
    const entityId = `0x${'00'.repeat(31)}03`;
    const privateKey = deriveSignerKeySync(runtimeSeed, '3');
    const encryption = deriveEncryptionKeyPair(`${hex(privateKey)}:${entityId}:htlc-v1`);
    const state = processSenderState(
      entityId,
      signerId,
      pubKeyToHex(encryption.publicKey),
      hex(encryption.privateKey),
    );
    for (const task of state.crontabState?.tasks.values() ?? []) task.enabled = false;

    const env = createEmptyEnv(runtimeSeed);
    registerSignerKey(env, signerId, privateKey);
    env.dbNamespace = `${env.runtimeId}-local-profile-${process.pid}`;
    env.scenarioMode = true;
    env.timestamp = state.timestamp;
    env.quietRuntimeLogs = true;
    env.eReplicas.set(`${entityId}:${signerId}`, {
      entityId,
      signerId,
      isProposer: true,
      mempool: [],
      state,
      hankoWitness: new Map(),
    });
    const evidence = await anchorManualGenesisReplica(env, state);
    if (!evidence) throw new Error('HTLC_TEST_REGISTRATION_EVIDENCE_MISSING');
    await certifyRegisteredBoardPrefix(env, entityId, signerId, evidence);

    const certificationFrame = processRuntime(env, [{ entityId, signerId, entityTxs: [] }]);
    // The input crossed ingress before checkpoint quiescing. process() then
    // yields while materializing durable jurisdiction work; a checkpoint may
    // establish its fence before the deterministic profile continuation is
    // queued. The already-accepted frame must still finish in memory.
    env.runtimeState ??= {};
    env.runtimeState.persistencePaused = true;
    env.runtimeState.persistenceQuiescing = true;
    await certificationFrame;
    env.runtimeState.persistenceQuiescing = false;

    const profile = env.gossip.getProfiles().find((candidate) => candidate.entityId === entityId);
    expect(profile?.metadata.profileHanko).toBeDefined();
    expect(profile && (await verifyProfileSignature(profile, env)).valid).toBe(true);
    const certifyTxCount = env.history
      .flatMap((frame) => frame.runtimeInput.entityInputs)
      .flatMap((input) => input.entityTxs ?? [])
      .filter((tx) => tx.type === 'certifyProfile').length;
    expect(certifyTxCount).toBe(1);

    await processRuntime(env, [{ entityId, signerId, entityTxs: [] }]);
    const certifyTxCountAfterIdleFrame = env.history
      .flatMap((frame) => frame.runtimeInput.entityInputs)
      .flatMap((input) => input.entityTxs ?? [])
      .filter((tx) => tx.type === 'certifyProfile').length;
    expect(certifyTxCountAfterIdleFrame).toBe(1);

    await processRuntime(env, [{
      entityId,
      signerId,
      entityTxs: [{
        type: 'profile-update',
        data: {
          profile: {
            entityId,
            name: 'recertified-profile',
            avatar: '',
            bio: '',
            website: '',
          },
        },
      }],
    }]);
    const uncertifiedUpdate = env.gossip.getProfiles().find((candidate) => candidate.entityId === entityId);
    expect(uncertifiedUpdate?.name).toBe('certified-profile');

    await processRuntime(env, [{ entityId, signerId, entityTxs: [] }]);
    const recertified = env.gossip.getProfiles().find((candidate) => candidate.entityId === entityId);
    expect(recertified?.name).toBe('recertified-profile');
    expect(recertified?.metadata.profileHanko).toBeDefined();
    expect(recertified && (await verifyProfileSignature(recertified, env)).valid).toBe(true);
    const recertificationFrameTxTypes = env.history.slice(-2).map((frame) => (
      frame.runtimeInput.entityInputs.flatMap((input) => input.entityTxs?.map((tx) => tx.type) ?? [])
    ));
    expect(recertificationFrameTxTypes).toEqual([['profile-update'], ['certifyProfile']]);
    const recertifyTxCount = env.history
      .flatMap((frame) => frame.runtimeInput.entityInputs)
      .flatMap((input) => input.entityTxs ?? [])
      .filter((tx) => tx.type === 'certifyProfile').length;
    expect(recertifyTxCount).toBe(2);

    await processRuntime(env, [{ entityId, signerId, entityTxs: [] }]);
    const recertifyTxCountAfterIdleFrame = env.history
      .flatMap((frame) => frame.runtimeInput.entityInputs)
      .flatMap((input) => input.entityTxs ?? [])
      .filter((tx) => tx.type === 'certifyProfile').length;
    expect(recertifyTxCountAfterIdleFrame).toBe(2);
    clearSignerKeys(env);
  });

  test('deduplicates P2P and core lifecycle requests for the same profile certification frame', async () => {
    const runtimeSeed = 'local-profile-lifecycle-p2p-dedup';
    const signerId = deriveSignerAddressSync(runtimeSeed, '4').toLowerCase();
    const entityId = `0x${'00'.repeat(31)}04`;
    const privateKey = deriveSignerKeySync(runtimeSeed, '4');
    const encryption = deriveEncryptionKeyPair(`${hex(privateKey)}:${entityId}:htlc-v1`);
    const state = processSenderState(
      entityId,
      signerId,
      pubKeyToHex(encryption.publicKey),
      hex(encryption.privateKey),
    );
    for (const task of state.crontabState?.tasks.values() ?? []) task.enabled = false;

    const env = createEmptyEnv(runtimeSeed);
    registerSignerKey(env, signerId, privateKey);
    env.dbNamespace = `${env.runtimeId}-local-profile-p2p-${process.pid}`;
    env.scenarioMode = true;
    env.timestamp = state.timestamp;
    env.quietRuntimeLogs = true;
    env.eReplicas.set(`${entityId}:${signerId}`, {
      entityId,
      signerId,
      isProposer: true,
      mempool: [],
      state,
      hankoWitness: new Map(),
    });
    const evidence = await anchorManualGenesisReplica(env, state);
    if (!evidence) throw new Error('HTLC_TEST_REGISTRATION_EVIDENCE_MISSING');
    await certifyRegisteredBoardPrefix(env, entityId, signerId, evidence);
    const certificationsBeforeP2P = env.history
      .flatMap((frame) => frame.runtimeInput.entityInputs)
      .flatMap((input) => input.entityTxs ?? [])
      .filter((tx) => tx.type === 'certifyProfile').length;
    const [announcement] = collectLocalProfileEncryptionAnnouncements(env);
    if (!announcement) throw new Error('PROFILE_P2P_DEDUP_ANNOUNCEMENT_MISSING');
    const p2p = startP2P(env, {
      runtimeId: env.runtimeId!,
      signerId,
      relayUrls: [],
      advertiseEntityIds: [entityId],
    });
    if (!p2p) throw new Error('PROFILE_P2P_DEDUP_RUNTIME_MISSING');
    try {
      (p2p as unknown as {
        applyIncomingEncryptionAnnouncements: (from: string, announcements: unknown[]) => void;
      }).applyIncomingEncryptionAnnouncements('peer-runtime', [announcement]);
      const pendingBeforeProcess = env.runtimeMempool?.entityInputs
        .flatMap((input) => input.entityTxs ?? [])
        .filter((tx) => tx.type === 'certifyProfile').length ?? 0;
      expect(pendingBeforeProcess).toBe(1);

      await processRuntime(env, [{ entityId, signerId, entityTxs: [] }]);

      const committedCertifications = env.history
        .flatMap((frame) => frame.runtimeInput.entityInputs)
        .flatMap((input) => input.entityTxs ?? [])
        .filter((tx) => tx.type === 'certifyProfile').length;
      const pendingAfterCommit = env.runtimeMempool?.entityInputs
        .flatMap((input) => input.entityTxs ?? [])
        .filter((tx) => tx.type === 'certifyProfile').length ?? 0;
      expect(committedCertifications).toBe(certificationsBeforeP2P + 1);
      expect(pendingAfterCommit).toBe(0);
    } finally {
      await stopP2PAndWait(env);
      clearSignerKeys(env);
    }
  });

  test('recomputes public multi-hop quote, deadlines and certified manifest bindings before state mutation', async () => {
    const destination = await certifiedGossipProfile();
    const hub = await certifiedSingleSignerHubProfile(destination.entityId);
    const senderProfile = await certifiedSenderGossipProfile();
    const state = senderState();
    state.lastFinalizedJHeight = 41;
    const admissionEnv = {
      height: 10,
      timestamp: state.timestamp,
      runtimeSeed: 'multihop-admission',
      eReplicas: new Map(),
      gossip: {
        getProfiles: () => [senderProfile, hub, destination],
        getNetworkGraph: () => ({ findPaths: async () => [] }),
      },
    } as unknown as Env;
    const rawSecret = `0x${'bc'.repeat(32)}`;
    const raw = withDeterministicHtlcTestSecret({
      type: 'htlcPayment' as const,
      data: {
        targetEntityId: destination.entityId,
        tokenId: 1,
        amount: 25n,
        route: [SENDER_ID, hub.entityId, destination.entityId],
        description: 'certified multi-hop',
        startedAtMs: state.timestamp,
      },
    }, rawSecret);
    const prepared = await prepareHtlcPaymentEntityTx(admissionEnv, state, raw);
    expect(prepared.data.preparedRouteProfiles).toHaveLength(2);
    expect(prepared.data.preparedHopForwardAmounts).toEqual([{ entityId: hub.entityId, amount: '25' }]);

    const validatorEnvA = {
      ...admissionEnv,
      gossip: undefined,
      jReplicas: new Map([['j', { blockNumber: 41 }]]),
    } as unknown as Env;
    const validatorEnvB = {
      ...admissionEnv,
      gossip: undefined,
      jReplicas: new Map([['j', { blockNumber: 999 }]]),
    } as unknown as Env;
    const [validatedA, validatedB] = await Promise.all([
      validatePreparedHtlcPayment(validatorEnvA, structuredClone(state), prepared),
      validatePreparedHtlcPayment(validatorEnvB, structuredClone(state), prepared),
    ]);
    expect(validatedA).toEqual(validatedB);

    const safelyAdvancedState = structuredClone(state);
    safelyAdvancedState.lastFinalizedJHeight += 1;
    await expect(validatePreparedHtlcPayment(
      validatorEnvA,
      safelyAdvancedState,
      prepared,
    )).resolves.toEqual(validatedA);

    const unsafeAdvancedState = structuredClone(state);
    unsafeAdvancedState.lastFinalizedJHeight =
      Number(prepared.data.preparedRevealBeforeHeight) - (raw.data.route.length - 2);
    await expect(validatePreparedHtlcPayment(
      validatorEnvA,
      unsafeAdvancedState,
      prepared,
    )).rejects.toThrow('HTLC_PAYMENT_PREPARED_DEADLINE_UNSAFE');

    const rejectsMutation = async (
      mutate: (candidate: typeof prepared) => void,
      code: string,
    ): Promise<void> => {
      const candidate = structuredClone(prepared);
      const stateBefore = serializeTaggedJson(state);
      mutate(candidate);
      await expect(validatePreparedHtlcPayment(validatorEnvA, state, candidate)).rejects.toThrow(code);
      expect(serializeTaggedJson(state)).toBe(stateBefore);
    };
    await rejectsMutation((candidate) => {
      candidate.data.preparedRouteProfiles = candidate.data.preparedRouteProfiles!.slice(1);
    }, 'HTLC_PAYMENT_PREPARED_ROUTE_PROFILE_COUNT_MISMATCH');
    await rejectsMutation((candidate) => {
      candidate.data.preparedRouteProfiles = [...candidate.data.preparedRouteProfiles!].reverse();
    }, 'HTLC_PAYMENT_PREPARED_ROUTE_PROFILE_ORDER_MISMATCH');
    await rejectsMutation((candidate) => {
      candidate.data.preparedHopForwardAmounts = [];
    }, 'HTLC_PAYMENT_PREPARED_FORWARD_AMOUNT_MISMATCH');
    await rejectsMutation((candidate) => {
      candidate.data.preparedHopForwardAmounts![0]!.amount = '26';
    }, 'HTLC_PAYMENT_PREPARED_FORWARD_AMOUNT_MISMATCH');
    await rejectsMutation((candidate) => {
      (candidate.data.preparedHopForwardAmounts![0]! as Record<string, unknown>)['provider'] = 'ignored-before-fix';
    }, 'HTLC_PAYMENT_PREPARED_FORWARD_AMOUNT_MISMATCH');
    await rejectsMutation((candidate) => {
      candidate.data.preparedSenderLockAmount = (BigInt(candidate.data.preparedSenderLockAmount!) + 1n).toString();
      candidate.data.preparedTotalFee = (BigInt(candidate.data.preparedTotalFee!) + 1n).toString();
    }, 'HTLC_PAYMENT_PREPARED_QUOTE_MISMATCH');
    await rejectsMutation((candidate) => {
      candidate.data.preparedTimelock = (BigInt(candidate.data.preparedTimelock!) + 1n).toString();
    }, 'HTLC_PAYMENT_PREPARED_DEADLINE_MISMATCH');
    await rejectsMutation((candidate) => {
      candidate.data.preparedRevealBeforeHeight = candidate.data.preparedRevealBeforeHeight! + 1;
    }, 'HTLC_PAYMENT_PREPARED_DEADLINE_MISMATCH');
    await rejectsMutation((candidate) => {
      candidate.data.preparedRouteProfiles![0]!.descriptor.metadata.routingFeePPM += 1;
    }, 'HTLC_PAYMENT_PREPARED_ROUTE_PROFILE_HANKO_INVALID');
    await rejectsMutation((candidate) => {
      const capacities = candidate.data.preparedRouteProfiles![0]!.descriptor.accounts[0]!.tokenCapacities as Record<
        string,
        { outCapacity: string; inCapacity: string }
      >;
      capacities['1']!.outCapacity = '999';
    }, 'HTLC_PAYMENT_PREPARED_ROUTE_PROFILE_HANKO_INVALID');
    await rejectsMutation((candidate) => {
      (candidate.data.preparedRouteProfiles![0]!.descriptor as unknown as Record<string, unknown>)['provider'] = {
        attackerControlled: true,
      };
    }, 'HTLC_PAYMENT_PREPARED_ROUTE_PROFILE_DESCRIPTOR_INVALID');
    await rejectsMutation((candidate) => {
      (candidate.data.preparedEnvelope as Record<string, unknown>)['provider'] = 'ignored-before-fix';
    }, 'HTLC_PAYMENT_PREPARED_ENVELOPE_SHAPE_INVALID');

    await expect(prepareHtlcPaymentEntityTx(admissionEnv, state, withDeterministicHtlcTestSecret({
      ...raw,
      data: { ...raw.data, description: 'x'.repeat(257) },
    }, rawSecret))).rejects.toThrow('HTLC_PAYMENT_DESCRIPTION_TOO_LONG');
    await expect(prepareHtlcPaymentEntityTx(admissionEnv, state, withDeterministicHtlcTestSecret({
      ...raw,
      data: { ...raw.data, startedAtMs: 0 },
    }, rawSecret))).rejects.toThrow('HTLC_PAYMENT_STARTED_AT_INVALID');
  });

  test('cold-start gossip publishes partial self-attestations before a routable profile exists', async () => {
    const stateFor = (validator: typeof first) => ({
      entityId: ENTITY_ID,
      entityEncPubKey: validator.encryptionPublicKey,
      entityEncPrivKey: validator.encryptionPrivateKey,
      config: {
        threshold: 2n,
        validators: [first.signer, second.signer],
        shares: { [first.signer]: 1n, [second.signer]: 1n },
      },
    });
    const envFor = (validator: typeof first): Env => ({
      runtimeSeed: `isolated-${validator.signerId}`,
      runtimeState: {},
      eReplicas: new Map([[`${ENTITY_ID}:${validator.signer}`, {
        entityId: ENTITY_ID,
        signerId: validator.signer,
        state: stateFor(validator),
      }]]),
      gossip: { getProfiles: () => [] },
      warn: () => {},
    } as unknown as Env);
    const p2pFor = (env: Env, runtimeId: string) => new RuntimeP2P({
      env,
      runtimeId,
      onEntityInput: (_from: string, _input: RoutedEntityInput) => {},
      onGossipProfiles: () => {},
    });

    const firstEnv = envFor(first);
    registerSignerKey(firstEnv, first.signer, first.privateKey);
    const [firstAnnouncement] = collectLocalProfileEncryptionAnnouncements(firstEnv);
    expect(firstAnnouncement?.attestation.signer).toBe(first.signer);
    const firstP2P = p2pFor(firstEnv, first.signer);
    const firstColdStart = firstP2P as unknown as {
      getLocalProfilesForEntities: () => Promise<unknown[]>;
      getLocalEncryptionAnnouncements: () => unknown[];
    };
    expect(await firstColdStart.getLocalProfilesForEntities()).toEqual([]);
    expect(firstColdStart.getLocalEncryptionAnnouncements()).toHaveLength(1);

    const secondEnv = envFor(second);
    registerSignerKey(secondEnv, second.signer, second.privateKey);
    const [secondAnnouncement] = collectLocalProfileEncryptionAnnouncements(secondEnv);
    expect(secondAnnouncement?.attestation.signer).toBe(second.signer);

    const secondP2P = p2pFor(secondEnv, second.signer);
    const apply = (p2p: RuntimeP2P, from: string, announcement: unknown) =>
      (p2p as unknown as {
        applyIncomingEncryptionAnnouncements: (sender: string, entries: unknown[]) => void;
      }).applyIncomingEncryptionAnnouncements(from, [announcement]);
    apply(firstP2P, second.signer, secondAnnouncement);
    apply(secondP2P, first.signer, firstAnnouncement);

    expect(getCompleteProfileEncryptionManifest(firstEnv, stateFor(first) as never)?.hash).toBe(
      getCompleteProfileEncryptionManifest(secondEnv, stateFor(second) as never)?.hash,
    );
    clearSignerKeys(firstEnv);
    clearSignerKeys(secondEnv);
  });

  test('rejects a bundle that omits the local validator or rewrites the manifest hash', async () => {
    const manifest = requireCompleteValidatorEncryptionManifest(board, [attest(first), attest(second)]);
    const profileCertification = await certifyManifest(manifest.hash);
    const ciphertext = await encryptForValidatorManifest(
      '{"finalRecipient":true,"secret":"preimage"}',
      manifest,
      profileCertification,
      CONTEXT_HASH,
      new NobleCryptoProvider(),
      first.signerId,
    );
    await expect(decryptForLocalValidator(
      { ...ciphertext, recipients: [] },
      board,
      first.signerId,
      first.encryptionPublicKey,
      first.encryptionPrivateKey,
      CONTEXT_HASH,
      new NobleCryptoProvider(),
    )).rejects.toThrow('HTLC_MULTI_RECIPIENT_COUNT_MISMATCH');
    await expect(decryptForLocalValidator(
      { ...ciphertext, manifest: { ...ciphertext.manifest, hash: `0x${'00'.repeat(32)}` } },
      board,
      first.signerId,
      first.encryptionPublicKey,
      first.encryptionPrivateKey,
      CONTEXT_HASH,
      new NobleCryptoProvider(),
    )).rejects.toThrow('HTLC_MULTI_RECIPIENT_MANIFEST_CORRUPTION');
    await expect(decryptForLocalValidator(
      ciphertext,
      board,
      first.signerId,
      first.encryptionPublicKey,
      first.encryptionPrivateKey,
      `0x${'b8'.repeat(32)}`,
      new NobleCryptoProvider(),
    )).rejects.toThrow('HTLC_ENCRYPTION_CONTEXT_MISMATCH');
    await expect(decryptForLocalValidator(
      {
        ...ciphertext,
        recipients: [{ ...ciphertext.recipients[0]!, wrappedKey: 'A'.repeat(516) }],
      },
      board,
      first.signerId,
      first.encryptionPublicKey,
      first.encryptionPrivateKey,
      CONTEXT_HASH,
      new NobleCryptoProvider(),
    )).rejects.toThrow('HTLC_WRAPPED_KEY_SIZE_INVALID');
  });
});
