import { Wallet } from 'ethers';
import type { AccountReplica } from '../types/account';
import { buildAccountProofBodyFromJurisdictions } from '../account/consensus/helpers';
import { buildDisputeArgumentsForCurrentState } from '../entity/dispute-arguments';
import type { EntityState } from '../entity/types';
import { buildSingleSignerHanko } from '../hanko/batch';
import {
  buildTowerAppointmentOwnerMessage,
  computeWatchtowerCounterDisputeAuthorizationHash,
  deriveRuntimeRecoveryActionLookupKey,
  encryptTowerPayloadForWatchSeed,
} from '../storage/recovery/bundle/crypto';
import { deriveRuntimeSignerPrivateKey } from '../storage/recovery/bundle/seed-identity';
import { decodeTowerProofBody } from '../storage/recovery/tower-proof-body';
import type {
  EncryptedRuntimeRecoveryBundleV1,
  TowerAppointmentV1,
  TowerCounterDisputeRemedy,
  TowerLastResortPayloadV1,
  TowerProofBody,
} from '../storage/recovery/bundle/types';
import type { RecoveryTowerConfig } from '../storage/recovery/discovery/types';
import type { JReplica } from '../types/jurisdiction-runtime';
import { encodeTowerCounterDisputeRemedy } from './action';

/**
 * Appointing a tower to answer a dispute the owner cannot answer themselves.
 *
 * One appointment is published per concrete bilateral account. The tower never
 * gets spend authority: it receives the latest counterparty-signed proof plus a
 * narrow owner authorization bound to the tower address, the exact account pair,
 * the proof nonce and the last-resort window. Every value here is rebuilt from
 * current Account state, so a stale cached ProofBody can never become a second
 * authority.
 */

export type LastResortTowerAppointmentUpload = {
  tower: RecoveryTowerConfig;
  appointment: TowerAppointmentV1;
  lookupKey: string;
  triggerHint: string;
};

/** One account whose appointment could not be built; the others are still published. */
type LastResortAppointmentFailure = {
  entityId: string;
  counterpartyId: string;
  error: string;
};

type LastResortAppointmentBuild = {
  uploads: LastResortTowerAppointmentUpload[];
  failures: LastResortAppointmentFailure[];
};

export type LastResortAppointmentContext = {
  /** Owner Runtime id, lowercase. Signs every appointment envelope with HD account 0. */
  runtimeId: string;
  seed: string;
  jReplicas: ReadonlyMap<string, JReplica>;
  tower: RecoveryTowerConfig;
  towerSignerAddress: string;
  encryptedBundle: EncryptedRuntimeRecoveryBundleV1;
};

/** One watched Entity, already resolved to its jurisdiction facts by the wallet. */
export type LastResortEntityContext = {
  entityId: string;
  signerDerivationIndex: number;
  chainId: number;
  depositoryAddress: string;
  rpcUrl: string;
  entityState: EntityState;
};

type FrozenProofClaim = {
  counterpartyId: string;
  proofNonce: number;
  proposerIsLeft: boolean;
  proofBodyHash: string;
  proofHanko: string;
  watchSeed: string;
};

const lowerId = (value: unknown): string =>
  String(value || '')
    .trim()
    .toLowerCase();

/**
 * Only an account that already carries a counterparty-signed proof can be
 * defended. Anything else has nothing for the tower to submit.
 */
const readFrozenProofClaim = (rawCounterpartyId: string, account: AccountReplica): FrozenProofClaim | null => {
  const counterpartyId = lowerId(rawCounterpartyId);
  const proofNonce = Math.max(0, Math.floor(Number(account.counterpartyDisputeProofNonce || 0)));
  const proposerIsLeft = account.counterpartyDisputeProofProposerIsLeft;
  const proofBodyHash = lowerId(account.counterpartyDisputeProofBodyHash);
  const proofHanko = String(account.counterpartyDisputeProofHanko || '').trim();
  const watchSeed = lowerId(account.state.watchSeed);
  if (
    !counterpartyId ||
    proofNonce <= 0 ||
    typeof proposerIsLeft !== 'boolean' ||
    !proofBodyHash ||
    !proofHanko ||
    !/^0x[0-9a-f]{64}$/.test(watchSeed)
  ) {
    return null;
  }
  return { counterpartyId, proofNonce, proposerIsLeft, proofBodyHash, proofHanko, watchSeed };
};

/**
 * The remedy is a counter-dispute payload for the watched entity, so only the
 * watched side arguments are stored. The dispute starter's side is bound by
 * DisputeStarted and must be injected by tower action from the on-chain event:
 * a local guess can fail the hash check or reveal the wrong transformer evidence.
 */
const buildWatchedSideArguments = (
  entity: LastResortEntityContext,
  jReplicas: ReadonlyMap<string, JReplica>,
  account: AccountReplica,
  claim: FrozenProofClaim,
  finalProofbody: TowerProofBody,
): { leftArguments: string; rightArguments: string } => {
  const transformers = finalProofbody.transformers;
  if (!Array.isArray(transformers) || transformers.length === 0) {
    return { leftArguments: '0x', rightArguments: '0x' };
  }
  const watchedSide =
    lowerId(account.state.leftEntity) === entity.entityId
      ? 'left'
      : lowerId(account.state.rightEntity) === entity.entityId
        ? 'right'
        : null;
  if (!watchedSide) {
    throw new Error(`WATCHTOWER_ACCOUNT_SIDE_UNKNOWN:${entity.entityId}:${claim.counterpartyId}`);
  }
  const built = buildDisputeArgumentsForCurrentState(
    account,
    entity.entityState,
    { jReplicas },
    claim.counterpartyId,
    claim.proofBodyHash,
    { secretsSide: watchedSide },
  );
  return watchedSide === 'left'
    ? { leftArguments: built.leftArguments, rightArguments: '0x' }
    : { leftArguments: '0x', rightArguments: built.rightArguments };
};

const buildLastResortPayload = async (
  context: LastResortAppointmentContext,
  entity: LastResortEntityContext,
  account: AccountReplica,
  claim: FrozenProofClaim,
  lastResortWindowSeconds: number,
  finalProofbody: TowerProofBody,
): Promise<TowerLastResortPayloadV1> => {
  const ownerAuthorizationHash = computeWatchtowerCounterDisputeAuthorizationHash(
    entity.chainId,
    entity.depositoryAddress,
    context.towerSignerAddress,
    entity.entityId,
    claim.counterpartyId,
    claim.proofNonce,
    claim.proofBodyHash,
    lastResortWindowSeconds,
    claim.proofNonce,
  );
  const { leftArguments, rightArguments } = buildWatchedSideArguments(
    entity,
    context.jReplicas,
    account,
    claim,
    finalProofbody,
  );
  const remedy: TowerCounterDisputeRemedy = {
    version: 1,
    type: 'counter_dispute_remedy',
    rpcUrl: entity.rpcUrl,
    chainId: entity.chainId,
    depositoryAddress: entity.depositoryAddress,
    watchedEntityId: entity.entityId,
    towerAddress: context.towerSignerAddress,
    lastResortWindowSeconds,
    appointmentSequence: claim.proofNonce,
    ownerAuthorizationHanko: buildSingleSignerHanko(
      entity.entityId,
      ownerAuthorizationHash,
      deriveRuntimeSignerPrivateKey(context.seed, entity.signerDerivationIndex),
    ),
    latestProof: {
      counterentity: claim.counterpartyId,
      finalNonce: claim.proofNonce,
      proposerIsLeft: claim.proposerIsLeft,
      finalProofbody,
      leftArguments,
      rightArguments,
      sig: claim.proofHanko,
    },
  };
  // The Runtime owns the remedy wire format. Reusing its tagged codec keeps
  // signed int256/uint256 values as bigint across encrypt/decrypt instead of
  // letting a JSON replacer silently turn financial values into decimal strings
  // that the fail-closed watchtower must reject.
  return {
    triggerHint: `chain:${entity.chainId}:acct:${entity.entityId}:${claim.counterpartyId}`,
    watch: {
      rpcUrl: entity.rpcUrl,
      chainId: entity.chainId,
      depositoryAddress: entity.depositoryAddress,
      watchedEntityId: entity.entityId,
      counterentity: claim.counterpartyId,
    },
    encryptedRemedy: await encryptTowerPayloadForWatchSeed(
      encodeTowerCounterDisputeRemedy(remedy),
      claim.watchSeed,
    ),
    actionKind: 'counter_dispute_only',
    appointmentSequence: claim.proofNonce,
    proofNonce: claim.proofNonce,
    proofBodyHash: claim.proofBodyHash,
    responseMode: 'last_resort',
    lastResortWindowSeconds,
  };
};

const buildAccountLastResortAppointment = async (
  context: LastResortAppointmentContext,
  entity: LastResortEntityContext,
  rawCounterpartyId: string,
  account: AccountReplica,
): Promise<LastResortTowerAppointmentUpload | null> => {
  const claim = readFrozenProofClaim(rawCounterpartyId, account);
  if (!claim) return null;

  // A disputing Account is frozen. Rebuild the one proof from that state;
  // never resurrect a historical ProofBody cache as a second authority.
  const currentProof = buildAccountProofBodyFromJurisdictions({ jReplicas: context.jReplicas }, account);
  if (lowerId(currentProof.proofBodyHash) !== claim.proofBodyHash) {
    throw new Error(
      `WATCHTOWER_FROZEN_PROOF_MISMATCH:${entity.entityId}:${claim.counterpartyId}:` +
        `${claim.proofBodyHash}:${currentProof.proofBodyHash}`,
    );
  }
  const finalProofbody = decodeTowerProofBody(currentProof.proofBodyStruct);
  const totalResponseSeconds =
    Number(finalProofbody.leftResponseSeconds) + Number(finalProofbody.rightResponseSeconds);
  if (!Number.isSafeInteger(totalResponseSeconds) || totalResponseSeconds <= 0) {
    // A zero-window account has no delayed phase for a tower to enter. Do not
    // invent a global substitute: the bilateral ProofBody is the complete timing
    // authority and the owner may intentionally choose zero.
    return null;
  }
  if (lowerId(finalProofbody.watchSeed) !== claim.watchSeed) {
    throw new Error(`WATCHTOWER_PROOF_BODY_WATCH_SEED_MISMATCH:${entity.entityId}:${claim.counterpartyId}`);
  }
  // Towers are deliberately eligible only in the final 20% of this exact
  // account's signed seconds window. This is an owner-signed appointment policy,
  // not consensus configuration; changing it cannot retune L1.
  const lastResortWindowSeconds = Math.max(1, Math.ceil(totalResponseSeconds * 0.2));
  const lastResortPayload = await buildLastResortPayload(
    context,
    entity,
    account,
    claim,
    lastResortWindowSeconds,
    finalProofbody,
  );
  // Last-resort appointments use a separate blind lookup namespace so towers
  // cannot infer backup availability from the action channel and vice versa.
  // The ciphertext stays opaque to the tower either way.
  const lookupKey = deriveRuntimeRecoveryActionLookupKey(
    context.runtimeId,
    context.seed,
    entity.entityId,
    claim.counterpartyId,
  );
  const appointmentBundle: EncryptedRuntimeRecoveryBundleV1 = { ...context.encryptedBundle, lookupKey };
  const signedAt = Date.now();
  const signature = await new Wallet(deriveRuntimeSignerPrivateKey(context.seed, 0)).signMessage(
    buildTowerAppointmentOwnerMessage(
      context.runtimeId,
      'delayed_last_resort',
      lookupKey,
      0,
      appointmentBundle,
      signedAt,
      lastResortPayload,
    ),
  );
  return {
    tower: context.tower,
    lookupKey,
    triggerHint: lastResortPayload.triggerHint,
    appointment: {
      type: 'tower_appointment',
      version: 1,
      towerMode: 'delayed_last_resort',
      lookupKey,
      slot: 0,
      bundle: appointmentBundle,
      lastResortPayload,
      ownerProof: { runtimeId: context.runtimeId, signedAt, signature },
    },
  };
};

/**
 * Build every last-resort appointment this owner can publish to one tower.
 *
 * Callers resolve which Entity replicas they own and which jurisdiction each one
 * settles in; this decides what a tower is allowed to submit on their behalf.
 * The highest proof nonce wins per lookup key, so a re-run never downgrades an
 * already published appointment. An account that cannot be built is returned
 * as a failure: one such account used to leave every other account unprotected.
 */
export async function buildDelayedLastResortAppointments(
  context: LastResortAppointmentContext,
  entities: readonly LastResortEntityContext[],
): Promise<LastResortAppointmentBuild> {
  const uploads = new Map<string, LastResortTowerAppointmentUpload>();
  const failures: LastResortAppointmentFailure[] = [];
  for (const entity of entities) {
    for (const [rawCounterpartyId, account] of entity.entityState.accounts.entries()) {
      let upload: LastResortTowerAppointmentUpload | null;
      try {
        upload = await buildAccountLastResortAppointment(context, entity, rawCounterpartyId, account);
      } catch (error) {
        failures.push({
          entityId: entity.entityId,
          counterpartyId: lowerId(rawCounterpartyId),
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!upload) continue;
      const previous = uploads.get(upload.lookupKey);
      const previousNonce = previous?.appointment.lastResortPayload?.proofNonce || 0;
      if (!previous || previousNonce < (upload.appointment.lastResortPayload?.proofNonce || 0)) {
        uploads.set(upload.lookupKey, upload);
      }
    }
  }
  return { uploads: [...uploads.values()], failures };
}
