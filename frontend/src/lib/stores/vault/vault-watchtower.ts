import type {
  EncryptedRuntimeRecoveryBundleV1,
  RuntimeReplica,
  TowerAppointmentV1,
  TowerCounterDisputeRemedy,
  TowerLastResortPayloadV1,
  XLNModule,
} from '@xln/core/api/public/runtime-module';
import { Wallet } from 'ethers';
import { isMapLike } from '$lib/utils/runtime/liveRuntimeEnv';
import { resolveRpcUrl } from './vault-helpers';
import {
  derivePrivateKey,
  findEntityReplicaByEntityAndSigner,
  findJReplicaByName,
  getEntityReplicaJurisdictionName,
  getJReplicaContractAddress,
  getSignerDerivationIndex,
  normalizeEntityId,
  normalizeRuntimeId,
  type RecoveryTowerConfig,
  type Runtime,
} from './vault-recovery';

export type LastResortTowerAppointmentUpload = {
  tower: RecoveryTowerConfig;
  appointment: TowerAppointmentV1;
  lookupKey: string;
  triggerHint: string;
};

export async function buildDelayedLastResortAppointmentsForTower(
  runtime: Runtime,
  env: RuntimeReplica,
  xln: XLNModule,
  tower: RecoveryTowerConfig,
  towerSignerAddress: string,
  encryptedBundle: EncryptedRuntimeRecoveryBundleV1,
): Promise<LastResortTowerAppointmentUpload[]> {
  if (
    typeof xln.deriveRuntimeRecoveryActionLookupKey !== 'function' ||
    typeof xln.computeWatchtowerCounterDisputeAuthorizationHash !== 'function' ||
    typeof xln.buildTowerAppointmentOwnerMessage !== 'function' ||
    typeof xln.buildSingleSignerHanko !== 'function' ||
    typeof xln.encryptTowerPayloadForWatchSeed !== 'function' ||
    typeof xln.buildAccountProofBodyFromJurisdictions !== 'function' ||
    typeof xln.buildDisputeArgumentsForCurrentState !== 'function'
  ) {
    throw new Error('WATCHTOWER_RUNTIME_CAPABILITIES_MISSING');
  }

  const normalizedRuntimeId = normalizeRuntimeId(runtime.id);
  if (!normalizedRuntimeId || !runtime.seed) return [];

  const rootWallet = new Wallet(derivePrivateKey(runtime.seed, 0));
  const uploads = new Map<string, LastResortTowerAppointmentUpload>();

  // We publish one last-resort appointment per concrete bilateral account.
  // The tower never gets spend authority. It only receives the latest
  // counterparty-signed proof plus a narrow owner authorization bound to the
  // tower address, the exact account pair, and the last-resort window.
  for (const signer of runtime.signers || []) {
    const entityId = normalizeEntityId(signer.entityId);
    const signerAddress = normalizeRuntimeId(signer.address);
    if (!entityId || !signerAddress) continue;

    const replica = findEntityReplicaByEntityAndSigner(env, entityId, signerAddress);
    if (!isMapLike(replica?.state?.accounts)) continue;

    const jurisdictionName =
      getEntityReplicaJurisdictionName(replica) ||
      String(signer.jurisdiction || '').trim() ||
      String(env.activeJurisdiction || '').trim();
    const jReplica = findJReplicaByName(env, jurisdictionName);
    if (!jReplica) continue;

    let depositoryAddress = '';
    try {
      depositoryAddress = getJReplicaContractAddress(jReplica, 'depository');
    } catch {
      continue;
    }
    const chainId = Number(jReplica.chainId ?? 0);
    if (!Number.isFinite(chainId) || chainId <= 0) continue;

    const rpcBase = String(jReplica.rpcs?.[0] || '').trim();
    if (!rpcBase) continue;
    const rpcUrl = resolveRpcUrl(rpcBase);
    const signerPrivateKey = derivePrivateKey(runtime.seed, getSignerDerivationIndex(signer));

    for (const [rawCounterpartyId, account] of replica.state.accounts.entries()) {
      const counterpartyId = normalizeEntityId(rawCounterpartyId);
      const proofNonce = Math.max(0, Math.floor(Number(account?.counterpartyDisputeProofNonce || 0)));
      const proposerIsLeft = account?.counterpartyDisputeProofProposerIsLeft;
      const proofBodyHash = String(account?.counterpartyDisputeProofBodyHash || '')
        .trim()
        .toLowerCase();
      const proofHanko = String(account?.counterpartyDisputeProofHanko || '').trim();
      const watchSeed = String(account?.state.watchSeed || '')
        .trim()
        .toLowerCase();
      if (
        !counterpartyId ||
        proofNonce <= 0 ||
        typeof proposerIsLeft !== 'boolean' ||
        !proofBodyHash ||
        !proofHanko ||
        !/^0x[0-9a-f]{64}$/.test(watchSeed)
      ) {
        continue;
      }

      const appointmentSequence = proofNonce;
      // A disputing Account is frozen. Rebuild the one proof from that state;
      // never resurrect a historical ProofBody cache as a second authority.
      const currentProof = xln.buildAccountProofBodyFromJurisdictions(
        { jReplicas: env.state.jReplicas },
        account,
      );
      if (currentProof.proofBodyHash.toLowerCase() !== proofBodyHash) {
        throw new Error(
          `WATCHTOWER_FROZEN_PROOF_MISMATCH:${entityId}:${counterpartyId}:` +
          `${proofBodyHash}:${currentProof.proofBodyHash}`,
        );
      }
      const finalProofbody = xln.decodeTowerProofBody(currentProof.proofBodyStruct);
      const leftResponseSeconds = Number(finalProofbody.leftResponseSeconds);
      const rightResponseSeconds = Number(finalProofbody.rightResponseSeconds);
      const totalResponseSeconds = leftResponseSeconds + rightResponseSeconds;
      if (!Number.isSafeInteger(totalResponseSeconds) || totalResponseSeconds <= 0) {
        // A zero-window account has no delayed phase for a tower to enter. Do
        // not invent a global substitute: the bilateral ProofBody is the complete
        // timing authority and the owner may intentionally choose zero.
        continue;
      }
      // Towers are deliberately eligible only in the final 20% of this exact
      // account's signed seconds window. This is an owner-signed appointment
      // policy, not consensus configuration; changing it cannot retune L1.
      const lastResortWindowSeconds = Math.max(1, Math.ceil(totalResponseSeconds * 0.2));
      const lookupKey = xln.deriveRuntimeRecoveryActionLookupKey(
        normalizedRuntimeId,
        runtime.seed,
        entityId,
        counterpartyId,
      );
      const ownerAuthorizationHash = xln.computeWatchtowerCounterDisputeAuthorizationHash(
        chainId,
        depositoryAddress,
        towerSignerAddress,
        entityId,
        counterpartyId,
        proofNonce,
        proofBodyHash,
        lastResortWindowSeconds,
        appointmentSequence,
      );
      const ownerAuthorizationHanko = xln.buildSingleSignerHanko(entityId, ownerAuthorizationHash, signerPrivateKey);

      const transformers = finalProofbody.transformers;
      let leftArguments = '0x';
      let rightArguments = '0x';
      if (Array.isArray(transformers) && transformers.length > 0) {
        const leftEntityId = normalizeEntityId(account.state.leftEntity);
        const rightEntityId = normalizeEntityId(account.state.rightEntity);
        const watchedSide = leftEntityId === entityId ? 'left' : rightEntityId === entityId ? 'right' : null;
        if (!watchedSide) {
          throw new Error(`WATCHTOWER_ACCOUNT_SIDE_UNKNOWN:${entityId}:${counterpartyId}`);
        }
        // The remedy is a counter-dispute payload for the watched entity. Store
        // only the watched side arguments here. The dispute starter's side is
        // bound by DisputeStarted and must be injected by tower action from the
        // on-chain event, otherwise a stale/local guess can fail the hash check or
        // reveal the wrong transformer evidence.
        const builtArguments = xln.buildDisputeArgumentsForCurrentState(
          account,
          replica.state,
          { jReplicas: env.state.jReplicas },
          counterpartyId,
          proofBodyHash,
          { secretsSide: watchedSide },
        );
        if (watchedSide === 'left') leftArguments = builtArguments.leftArguments;
        else rightArguments = builtArguments.rightArguments;
      }
      if (
        finalProofbody.watchSeed
          .trim()
          .toLowerCase() !== watchSeed
      ) {
        throw new Error(`WATCHTOWER_PROOF_BODY_WATCH_SEED_MISMATCH:${entityId}:${counterpartyId}`);
      }
      const remedy: TowerCounterDisputeRemedy = {
        version: 1,
        type: 'counter_dispute_remedy',
        rpcUrl,
        chainId,
        depositoryAddress,
        watchedEntityId: entityId,
        towerAddress: towerSignerAddress,
        lastResortWindowSeconds,
        appointmentSequence,
        ownerAuthorizationHanko,
        latestProof: {
          counterentity: counterpartyId,
          finalNonce: proofNonce,
          proposerIsLeft,
          finalProofbody,
          leftArguments,
          rightArguments,
          sig: proofHanko,
        },
      };
      // The Runtime owns the remedy wire format. Reusing its tagged codec keeps
      // signed int256/uint256 values as bigint across encrypt/decrypt instead of
      // letting a frontend JSON replacer silently turn financial values into
      // decimal strings that the fail-closed watchtower must reject.
      const serializedRemedy = xln.encodeTowerCounterDisputeRemedy(remedy);
      const encryptedRemedy = await xln.encryptTowerPayloadForWatchSeed(serializedRemedy, watchSeed);
      const triggerHint = `chain:${chainId}:acct:${entityId}:${counterpartyId}`;
      const lastResortPayload: TowerLastResortPayloadV1 = {
        triggerHint,
        watch: {
          rpcUrl,
          chainId,
          depositoryAddress,
          watchedEntityId: entityId,
          counterentity: counterpartyId,
        },
        encryptedRemedy,
        actionKind: 'counter_dispute_only',
        appointmentSequence,
        proofNonce,
        proofBodyHash,
        responseMode: 'last_resort',
        lastResortWindowSeconds,
      };
      const appointmentBundle: EncryptedRuntimeRecoveryBundleV1 = {
        ...encryptedBundle,
        lookupKey,
      };
      const signedAt = Date.now();
      const ownerProofSignature = await rootWallet.signMessage(
        xln.buildTowerAppointmentOwnerMessage(
          normalizedRuntimeId,
          'delayed_last_resort',
          lookupKey,
          0,
          appointmentBundle,
          signedAt,
          lastResortPayload,
        ),
      );
      const nextUpload: LastResortTowerAppointmentUpload = {
        tower,
        lookupKey,
        triggerHint,
        appointment: {
          type: 'tower_appointment',
          version: 1,
          towerMode: 'delayed_last_resort',
          lookupKey,
          slot: 0,
          // Last-resort appointments use a separate blind lookup namespace so towers
          // cannot infer backup availability from the action channel and vice
          // versa. The ciphertext stays opaque to the tower either way.
          bundle: appointmentBundle,
          lastResortPayload,
          ownerProof: {
            runtimeId: normalizedRuntimeId,
            signedAt,
            signature: ownerProofSignature,
          },
        },
      };
      const previous = uploads.get(lookupKey);
      if (!previous || (previous.appointment.lastResortPayload?.proofNonce || 0) < proofNonce) {
        uploads.set(lookupKey, nextUpload);
      }
    }
  }

  return [...uploads.values()];
}
