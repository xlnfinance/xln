import type {
  EncryptedRuntimeRecoveryBundleV1,
  RuntimeReplica,
  TowerAppointmentV1,
  TowerCounterDisputeRemedy,
  TowerLastResortPayloadV1,
  XLNModule,
} from '@xln/runtime/api/runtime-module';
import { Wallet } from 'ethers';
import { resolveRpcUrl } from './vault-helpers';
import {
  WATCHTOWER_LAST_RESORT_WINDOW_BLOCKS,
  WATCHTOWER_SAFETY_MARGIN_BLOCKS,
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
    typeof xln.encryptTowerPayloadForWatchSeed !== 'function'
  ) {
    return [];
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
    if (!replica?.state?.accounts || !(replica.state.accounts instanceof Map)) continue;

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
      const proofBodyHash = String(account?.counterpartyDisputeProofBodyHash || '')
        .trim()
        .toLowerCase();
      const proofHanko = String(account?.counterpartyDisputeProofHanko || '').trim();
      const proofBody = proofBodyHash ? account?.disputeProofBodiesByHash?.[proofBodyHash] : null;
      const watchSeed = String(account?.watchSeed || '')
        .trim()
        .toLowerCase();
      if (
        !counterpartyId ||
        proofNonce <= 0 ||
        !proofBodyHash ||
        !proofHanko ||
        !proofBody ||
        typeof proofBody !== 'object' ||
        !/^0x[0-9a-f]{64}$/.test(watchSeed)
      ) {
        continue;
      }

      const appointmentSequence = proofNonce;
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
        WATCHTOWER_LAST_RESORT_WINDOW_BLOCKS,
        appointmentSequence,
      );
      const ownerAuthorizationHanko = xln.buildSingleSignerHanko(entityId, ownerAuthorizationHash, signerPrivateKey);

      const finalProofbody = xln.decodeTowerProofBody(proofBody);
      const transformers = finalProofbody.transformers;
      let leftArguments = '0x';
      let rightArguments = '0x';
      if (Array.isArray(transformers) && transformers.length > 0) {
        if (typeof xln.buildDisputeArgumentsForSnapshot !== 'function') {
          throw new Error('WATCHTOWER_ARGUMENT_BUILDER_UNAVAILABLE');
        }
        const leftEntityId = normalizeEntityId(account.leftEntity);
        const rightEntityId = normalizeEntityId(account.rightEntity);
        const watchedSide = leftEntityId === entityId ? 'left' : rightEntityId === entityId ? 'right' : null;
        if (!watchedSide) {
          throw new Error(`WATCHTOWER_ACCOUNT_SIDE_UNKNOWN:${entityId}:${counterpartyId}`);
        }
        // The remedy is a counter-dispute payload for the watched entity. Store
        // only the watched side arguments here. The dispute starter's side is
        // bound by DisputeStarted and must be injected by tower action from the
        // on-chain event, otherwise a stale/local guess can fail the hash check or
        // reveal the wrong transformer evidence.
        const builtArguments = xln.buildDisputeArgumentsForSnapshot(
          account,
          replica.state,
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
        lastResortWindowBlocks: WATCHTOWER_LAST_RESORT_WINDOW_BLOCKS,
        appointmentSequence,
        ownerAuthorizationHanko,
        latestProof: {
          counterentity: counterpartyId,
          finalNonce: proofNonce,
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
        lastResortWindowBlocks: WATCHTOWER_LAST_RESORT_WINDOW_BLOCKS,
        safetyMarginBlocks: WATCHTOWER_SAFETY_MARGIN_BLOCKS,
      };
      const signedAt = Date.now();
      const ownerProofSignature = await rootWallet.signMessage(
        xln.buildTowerAppointmentOwnerMessage(
          normalizedRuntimeId,
          'delayed_last_resort',
          lookupKey,
          0,
          encryptedBundle.bundleHash,
          encryptedBundle.height,
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
          bundle: {
            ...encryptedBundle,
            lookupKey,
          },
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
