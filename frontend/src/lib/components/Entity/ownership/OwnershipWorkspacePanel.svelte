<script lang="ts">
import type {
  EnvSnapshot,
  JAdapter,
  RuntimeReplica,
  XLNModule,
} from "@xln/core/api/public/runtime-module";
import { isNumberedEntity, toEntityId } from "@xln/core/api/public/runtime-module";
import type { EntityReplica } from "$lib/types/ui";
import { getXLN, submitEntityInputs } from "$lib/stores/xlnStore";
import { toasts } from "$lib/stores/ui/toastStore";
import { requireRuntimeEnv } from "../core/entity-panel-model";
import type { ExternalToken } from "../assets/entity-asset-catalog";
import OwnershipPanel from "./OwnershipPanel.svelte";
import {
  buildControlBoardActivationInputs,
  buildControlBoardProposalInput,
  buildEntityShareReleaseInput,
  projectEntityShareTokens,
  type ControlTakeoverBoard,
} from "./ownership-flow";

export let entityName: string;
export let entityId: string;
export let signerId: string;
export let replica: EntityReplica;
export let activeReplicas: Map<string, EntityReplica> | null;
export let entityNames: Map<string, string>;
export let externalTokens: ExternalToken[];
export let onchainReserves: Map<number, bigint>;
export let activeIsLive: boolean;
export let runtimeEnv: RuntimeReplica | EnvSnapshot | null;
export let runtimeModuleAvailable: boolean;
export let resolveEntitySigner: (entityId: string, reason: string) => string;
export let resolveJAdapter: (xln: XLNModule, env: RuntimeReplica, context: string) => JAdapter;
export let reportDiagnostic: (message: string, details?: unknown) => void;

let busy = false;
let error = "";
let takeoverTargetId = "";
let takeoverStatus: null | {
  targetEntityId: string;
  currentBoardHash: string;
  proposedBoardHash: string;
  currentUnix: bigint;
  activateAt: bigint;
} = null;

const errorMessage = (value: unknown, defaultMessage: string): string =>
  value instanceof Error && value.message ? value.message : defaultMessage;

$: isNumbered = (() => {
  if (!runtimeModuleAvailable || !entityId) return false;
  try {
    return isNumberedEntity(toEntityId(entityId));
  } catch {
    return false;
  }
})();
$: shareTokens = isNumbered
  ? projectEntityShareTokens(toEntityId(entityId), externalTokens, onchainReserves)
  : [];
$: actionState = replica.state.entityProviderActionState ?? null;
$: pendingAction = actionState?.pending ?? null;
$: pendingRelease = pendingAction?.payload.kind === "releaseControlShares"
  ? pendingAction
  : null;
$: takeoverTargets = (() => {
  const currentEntityId = entityId.toLowerCase();
  const currentSignerId = signerId.toLowerCase();
  const currentProvider = String(replica.state.config.jurisdiction?.entityProviderAddress || "").toLowerCase();
  const candidates = new Map<string, { entityId: string; name: string }>();
  for (const candidate of activeReplicas?.values() ?? []) {
    const candidateEntityId = String(candidate.state.entityId || candidate.entityId || "").toLowerCase();
    const candidateSigner = String(candidate.signerId || "").toLowerCase();
    const provider = String(candidate.state.config.jurisdiction?.entityProviderAddress || "").toLowerCase();
    if (
      !candidateEntityId
      || candidateEntityId === currentEntityId
      || candidateSigner !== currentSignerId
      || !candidate.state.config.validators.some(validator => validator.toLowerCase() === currentSignerId)
      || !currentProvider
      || provider !== currentProvider
    ) continue;
    candidates.set(candidateEntityId, {
      entityId: candidateEntityId,
      name: entityNames.get(candidateEntityId) || candidateEntityId,
    });
  }
  return [...candidates.values()].sort((left, right) => left.name.localeCompare(right.name));
})();
$: if (takeoverTargetId && !takeoverTargets.some(target => target.entityId === takeoverTargetId)) {
  takeoverTargetId = "";
  takeoverStatus = null;
}

const requireTakeoverTarget = (targetEntityId: string): EntityReplica => {
  const normalizedTarget = toEntityId(targetEntityId);
  const currentSignerId = signerId.toLowerCase();
  const target = activeReplicas?.get(`${normalizedTarget}:${currentSignerId}`)
    ?? [...(activeReplicas?.values() ?? [])].find(candidate => (
      String(candidate.state.entityId || candidate.entityId || "").toLowerCase() === normalizedTarget
      && String(candidate.signerId || "").toLowerCase() === currentSignerId
    ));
  if (!target) throw new Error(`CONTROL_TAKEOVER_TARGET_REPLICA_MISSING:${normalizedTarget}:${currentSignerId}`);
  if (!target.state.config.validators.some(validator => validator.toLowerCase() === currentSignerId)) {
    throw new Error(`CONTROL_TAKEOVER_MINORITY_VALIDATOR_REQUIRED:${normalizedTarget}:${currentSignerId}`);
  }
  return target;
};

const buildTakeoverBoard = (target: EntityReplica): ControlTakeoverBoard => ({
  mode: target.state.config.mode,
  threshold: 1n,
  validators: [signerId.toLowerCase()],
  shares: { [signerId.toLowerCase()]: 1n },
});

const refreshTakeover = async (targetEntityId: string): Promise<void> => {
  busy = true;
  error = "";
  try {
    const xln = await getXLN();
    const env = requireRuntimeEnv(runtimeEnv, "control-takeover-refresh");
    const target = requireTakeoverTarget(targetEntityId);
    const jadapter = resolveJAdapter(xln, env, "control-takeover-refresh");
    const entity = await jadapter.entityProvider.entities(target.state.entityId);
    // Governance delays are seconds: activateBoard needs block.timestamp >= activateAt.
    const latestBlock = await jadapter.provider.getBlock("latest");
    if (!latestBlock) throw new Error("CONTROL_TAKEOVER_LATEST_BLOCK_MISSING");
    takeoverTargetId = target.state.entityId.toLowerCase();
    takeoverStatus = {
      targetEntityId: takeoverTargetId,
      currentBoardHash: String(entity.currentBoardHash).toLowerCase(),
      proposedBoardHash: String(entity.proposedBoardHash).toLowerCase(),
      currentUnix: BigInt(latestBlock.timestamp),
      activateAt: BigInt(entity.activateAt),
    };
  } catch (cause) {
    error = errorMessage(cause, "CONTROL takeover status failed");
    toasts.error(error);
  } finally {
    busy = false;
  }
};

const proposeTakeover = async (targetEntityId: string): Promise<void> => {
  busy = true;
  error = "";
  try {
    const xln = await getXLN();
    const env = requireRuntimeEnv(runtimeEnv, "control-takeover-propose");
    const target = requireTakeoverTarget(targetEntityId);
    const proposerSignerId = resolveEntitySigner(entityId, "control-takeover-propose").toLowerCase();
    const board = buildTakeoverBoard(target);
    const encodedBoard = xln.encodeBoard({
      ...board,
      ...(target.state.config.jurisdiction
        ? { jurisdiction: structuredClone(target.state.config.jurisdiction) }
        : {}),
    }, env);
    const boardHash = xln.hashBoard(encodedBoard).toLowerCase();
    const jadapter = resolveJAdapter(xln, env, "control-takeover-propose");
    // proposeBoard accepts only committed (on-chain validated) board preimages.
    // Only this proposer holds the preimage; commit it before the proposal
    // carries the bare hash through Entity consensus.
    if (!(await jadapter.entityProvider.committedBoards(boardHash))) {
      const commitReceipt = await (await jadapter.entityProvider.commitBoard(encodedBoard)).wait();
      if (commitReceipt?.status !== 1) throw new Error(`BOARD_COMMIT_FAILED:${boardHash}`);
    }
    const actionNonce = BigInt(await jadapter.entityProvider.boardActionNonces(target.state.entityId)) + 1n;
    await submitEntityInputs([buildControlBoardProposalInput({
      shareholderEntityId: toEntityId(entityId),
      signerId: proposerSignerId,
      targetEntityId: toEntityId(target.state.entityId),
      newBoardHash: boardHash,
      actionNonce,
    })]);
    toasts.info("CONTROL board proposal submitted through Entity consensus");
  } catch (cause) {
    error = errorMessage(cause, "CONTROL board proposal failed");
    toasts.error(error);
  } finally {
    busy = false;
  }
};

const activateTakeover = async (targetEntityId: string): Promise<void> => {
  busy = true;
  error = "";
  try {
    const target = requireTakeoverTarget(targetEntityId);
    const proposerSignerId = resolveEntitySigner(entityId, "control-takeover-activate").toLowerCase();
    await submitEntityInputs([...buildControlBoardActivationInputs({
      shareholderEntityId: toEntityId(entityId),
      targetEntityId: toEntityId(target.state.entityId),
      signerId: proposerSignerId,
      board: buildTakeoverBoard(target),
    })]);
    toasts.info("Board activation and state handover submitted");
  } catch (cause) {
    error = errorMessage(cause, "Board activation failed");
    toasts.error(error);
  } finally {
    busy = false;
  }
};

const releaseTreasuryShares = async (): Promise<void> => {
  if (!runtimeModuleAvailable) throw new Error("ENTITY_SHARE_RUNTIME_MODULE_UNAVAILABLE");
  const normalizedEntityId = toEntityId(entityId);
  const currentSignerId = resolveEntitySigner(normalizedEntityId, "entity-share-release");
  const depositoryAddress = String(replica.state.config.jurisdiction?.depositoryAddress || "");
  busy = true;
  error = "";
  try {
    await submitEntityInputs([buildEntityShareReleaseInput({
      entityId: normalizedEntityId,
      signerId: currentSignerId,
      depositoryAddress,
    })]);
    toasts.info("Entity share issuance submitted to the board");
  } catch (cause) {
    error = errorMessage(cause, "Entity share issuance failed");
    reportDiagnostic("Entity share issuance failed", { error });
    toasts.error(error);
  } finally {
    busy = false;
  }
};
</script>

<OwnershipPanel
  {entityName}
  {entityId}
  {isNumbered}
  {activeIsLive}
  boardThreshold={replica.state.config.threshold}
  boardMemberCount={replica.state.config.validators.length}
  {shareTokens}
  releasePendingHash={pendingRelease?.actionHash ?? ""}
  releasePendingNonce={pendingRelease?.actionNonce ?? null}
  releaseConfirmedNonce={actionState?.confirmedNonce ?? 0n}
  releaseBlocked={pendingAction !== null && pendingRelease === null}
  {busy}
  {error}
  takeoverTargets={takeoverTargets}
  takeoverTargetId={takeoverTargetId}
  takeoverStatus={takeoverStatus}
  onReleaseShares={releaseTreasuryShares}
  onRefreshTakeover={refreshTakeover}
  onProposeTakeover={proposeTakeover}
  onActivateTakeover={activateTakeover}
/>
