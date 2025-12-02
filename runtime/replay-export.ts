/**
 * Replay Export/Import System
 *
 * Exports scenario history (EnvSnapshot[]) as portable JSON format
 * Handles BigInt serialization, optional compression, and format versioning
 *
 * Usage:
 *   const exported = exportReplay(env.history);
 *   const frames = importReplay(exported);
 */

import type { EnvSnapshot } from './types';
import { safeStringify } from './serialization-utils';

/**
 * Serialized replay export format
 * All BigInts converted to strings, Maps to arrays
 */
export interface ReplayExport {
  version: string;           // Format version (semver)
  exportedAt: string;        // ISO 8601 timestamp
  frameCount: number;        // Number of frames in export
  frames: SerializedFrame[]; // Serialized EnvSnapshot array
}

/**
 * Serialized frame structure (EnvSnapshot with primitives only)
 * All complex types (Map, BigInt) converted to JSON-safe formats
 */
export interface SerializedFrame {
  height: number;
  timestamp: number;
  replicas: Array<{
    entityId: string;
    replica: {
      entityId: string;
      signerId: string;
      isProposer: boolean;
      mempool: any[];
      position?: { x: number; y: number; z: number };
      state: {
        entityId: string;
        height: number;
        timestamp: number;
        nonces: Record<string, number>;
        messages: string[];
        proposals: Array<{ id: string; data: any }>;
        reserves: Record<string, string>; // tokenId -> amount (BigInt as string)
        accounts: Array<{
          counterpartyEntityId: string;
          machine: any; // Simplified for now
        }>;
        jBlock: number;
        config: any;
      };
    };
  }>;
  runtimeInput: any;
  runtimeOutputs: any[];
  description: string;
  gossip?: {
    profiles: any[];
  };
  xlnomies?: Array<{
    name: string;
    jMachine: {
      position: { x: number; y: number; z: number };
      capacity: number;
      jHeight: number;
    };
  }>;
  title?: string;
  narrative?: string;
  subtitle?: {
    title: string;
    what: string;
    why: string;
    tradfiParallel: string;
    keyMetrics?: string[];
  };
  viewState?: {
    camera?: 'orbital' | 'overview' | 'follow' | 'free';
    zoom?: number;
    focus?: string;
    panel?: 'accounts' | 'transactions' | 'consensus' | 'network';
    speed?: number;
    position?: { x: number; y: number; z: number };
    rotation?: { x: number; y: number; z: number };
  };
}

/**
 * Export replay history to portable JSON format
 * Converts all BigInts to strings, Maps to arrays
 *
 * @param history - EnvSnapshot[] from env.history
 * @returns ReplayExport with serialized frames
 */
export function exportReplay(history: EnvSnapshot[]): ReplayExport {
  return {
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    frameCount: history.length,
    frames: history.map(serializeFrame),
  };
}

/**
 * Import replay from exported JSON format
 * Converts strings back to BigInts, arrays to Maps
 *
 * @param data - ReplayExport from exportReplay()
 * @returns EnvSnapshot[] ready for env.history
 */
export function importReplay(data: ReplayExport): EnvSnapshot[] {
  // Version compatibility check
  const [major] = data.version.split('.').map(Number);
  if (major > 1) {
    throw new Error(`Unsupported replay version: ${data.version} (expected 1.x.x)`);
  }

  return data.frames.map(deserializeFrame);
}

/**
 * Serialize a single EnvSnapshot to JSON-safe format
 * Handles Maps, BigInts, and nested structures
 */
function serializeFrame(frame: EnvSnapshot): SerializedFrame {
  // Convert replicas Map to array
  const replicasArray = Array.from(frame.replicas.entries()).map(([entityId, replica]) => ({
    entityId,
    replica: serializeReplica(replica),
  }));

  return {
    height: frame.height,
    timestamp: frame.timestamp,
    replicas: replicasArray,
    runtimeInput: frame.runtimeInput,
    runtimeOutputs: frame.runtimeOutputs,
    description: frame.description,
    gossip: frame.gossip,
    xlnomies: frame.xlnomies,
    title: frame.title,
    narrative: frame.narrative,
    subtitle: frame.subtitle,
    viewState: frame.viewState,
  };
}

/**
 * Deserialize SerializedFrame back to EnvSnapshot
 * Converts arrays to Maps, strings to BigInts
 */
function deserializeFrame(serialized: SerializedFrame): EnvSnapshot {
  // Convert replicas array back to Map
  const replicasMap = new Map(
    serialized.replicas.map((item) => [item.entityId, deserializeReplica(item.replica)])
  );

  return {
    height: serialized.height,
    timestamp: serialized.timestamp,
    replicas: replicasMap,
    runtimeInput: serialized.runtimeInput,
    runtimeOutputs: serialized.runtimeOutputs,
    description: serialized.description,
    gossip: serialized.gossip,
    xlnomies: serialized.xlnomies,
    title: serialized.title,
    narrative: serialized.narrative,
    subtitle: serialized.subtitle,
    viewState: serialized.viewState,
  };
}

/**
 * Serialize EntityReplica (handles nested state)
 */
function serializeReplica(replica: any): any {
  return {
    entityId: replica.entityId,
    signerId: replica.signerId,
    isProposer: replica.isProposer,
    mempool: replica.mempool,
    position: replica.position,
    state: serializeEntityState(replica.state),
  };
}

/**
 * Deserialize EntityReplica
 */
function deserializeReplica(serialized: any): any {
  return {
    entityId: serialized.entityId,
    signerId: serialized.signerId,
    isProposer: serialized.isProposer,
    mempool: serialized.mempool,
    position: serialized.position,
    state: deserializeEntityState(serialized.state),
  };
}

/**
 * Serialize EntityState (handles reserves Map, proposals Map, accounts Map)
 */
function serializeEntityState(state: any): any {
  // Convert reserves Map<string, bigint> to Record<string, string>
  const reserves: Record<string, string> = {};
  if (state.reserves) {
    for (const [tokenId, amount] of state.reserves.entries()) {
      reserves[tokenId] = amount.toString();
    }
  }

  // Convert proposals Map to array
  const proposals = state.proposals
    ? Array.from(state.proposals.entries()).map(([id, proposal]) => ({
        id,
        data: serializeProposal(proposal),
      }))
    : [];

  // Convert accounts Map to array
  const accounts = state.accounts
    ? Array.from(state.accounts.entries()).map(([counterpartyId, machine]) => ({
        counterpartyEntityId: counterpartyId,
        machine: serializeAccountMachine(machine),
      }))
    : [];

  // Convert nonces Map to Record
  const nonces: Record<string, number> = {};
  if (state.nonces) {
    for (const [signerId, nonce] of state.nonces.entries()) {
      nonces[signerId] = nonce;
    }
  }

  return {
    entityId: state.entityId,
    height: state.height,
    timestamp: state.timestamp,
    nonces,
    messages: state.messages || [],
    proposals,
    reserves,
    accounts,
    jBlock: state.jBlock,
    config: state.config,
  };
}

/**
 * Deserialize EntityState
 */
function deserializeEntityState(serialized: any): any {
  // Convert reserves Record<string, string> back to Map<string, bigint>
  const reserves = new Map<string, bigint>();
  if (serialized.reserves) {
    for (const [tokenId, amountStr] of Object.entries(serialized.reserves)) {
      reserves.set(tokenId, BigInt(amountStr as string));
    }
  }

  // Convert proposals array back to Map
  const proposals = new Map(
    (serialized.proposals || []).map((item: any) => [item.id, deserializeProposal(item.data)])
  );

  // Convert accounts array back to Map
  const accounts = new Map(
    (serialized.accounts || []).map((item: any) => [
      item.counterpartyEntityId,
      deserializeAccountMachine(item.machine),
    ])
  );

  // Convert nonces Record back to Map
  const nonces = new Map(Object.entries(serialized.nonces || {}));

  return {
    entityId: serialized.entityId,
    height: serialized.height,
    timestamp: serialized.timestamp,
    nonces,
    messages: serialized.messages || [],
    proposals,
    reserves,
    accounts,
    jBlock: serialized.jBlock,
    config: serialized.config,
  };
}

/**
 * Serialize Proposal (handles votes Map)
 */
function serializeProposal(proposal: any): any {
  // Convert votes Map to array
  const votes = proposal.votes
    ? Array.from(proposal.votes.entries()).map(([signerId, vote]) => ({
        signerId,
        vote,
      }))
    : [];

  return {
    id: proposal.id,
    proposer: proposal.proposer,
    action: proposal.action,
    votes,
    status: proposal.status,
    created: proposal.created,
  };
}

/**
 * Deserialize Proposal
 */
function deserializeProposal(serialized: any): any {
  // Convert votes array back to Map
  const votes = new Map((serialized.votes || []).map((item: any) => [item.signerId, item.vote]));

  return {
    id: serialized.id,
    proposer: serialized.proposer,
    action: serialized.action,
    votes,
    status: serialized.status,
    created: serialized.created,
  };
}

/**
 * Serialize AccountMachine (handles deltas Map, pendingWithdrawals Map, requestedRebalance Map)
 */
function serializeAccountMachine(machine: any): any {
  // Convert deltas Map to array
  const deltas = machine.deltas
    ? Array.from(machine.deltas.entries()).map(([tokenId, delta]) => ({
        tokenId,
        delta: serializeDelta(delta),
      }))
    : [];

  // Convert pendingWithdrawals Map to array
  const pendingWithdrawals = machine.pendingWithdrawals
    ? Array.from(machine.pendingWithdrawals.entries()).map(([requestId, withdrawal]) => ({
        requestId,
        withdrawal: serializeWithdrawal(withdrawal),
      }))
    : [];

  // Convert requestedRebalance Map to array
  const requestedRebalance = machine.requestedRebalance
    ? Array.from(machine.requestedRebalance.entries()).map(([tokenId, amount]) => ({
        tokenId,
        amount: amount.toString(),
      }))
    : [];

  return {
    counterpartyEntityId: machine.counterpartyEntityId,
    mempool: machine.mempool,
    currentFrame: serializeAccountFrame(machine.currentFrame),
    sentTransitions: machine.sentTransitions,
    ackedTransitions: machine.ackedTransitions,
    deltas,
    globalCreditLimits: machine.globalCreditLimits
      ? {
          ownLimit: machine.globalCreditLimits.ownLimit.toString(),
          peerLimit: machine.globalCreditLimits.peerLimit.toString(),
        }
      : undefined,
    currentHeight: machine.currentHeight,
    pendingFrame: machine.pendingFrame ? serializeAccountFrame(machine.pendingFrame) : undefined,
    pendingSignatures: machine.pendingSignatures,
    rollbackCount: machine.rollbackCount,
    sendCounter: machine.sendCounter,
    receiveCounter: machine.receiveCounter,
    proofHeader: machine.proofHeader,
    proofBody: machine.proofBody
      ? {
          tokenIds: machine.proofBody.tokenIds,
          deltas: machine.proofBody.deltas.map((d: bigint) => d.toString()),
        }
      : undefined,
    hankoSignature: machine.hankoSignature,
    frameHistory: machine.frameHistory.map(serializeAccountFrame),
    pendingForward: machine.pendingForward
      ? {
          tokenId: machine.pendingForward.tokenId,
          amount: machine.pendingForward.amount.toString(),
          route: machine.pendingForward.route,
          description: machine.pendingForward.description,
        }
      : undefined,
    pendingWithdrawals,
    requestedRebalance,
  };
}

/**
 * Deserialize AccountMachine
 */
function deserializeAccountMachine(serialized: any): any {
  // Convert deltas array back to Map
  const deltas = new Map(
    (serialized.deltas || []).map((item: any) => [item.tokenId, deserializeDelta(item.delta)])
  );

  // Convert pendingWithdrawals array back to Map
  const pendingWithdrawals = new Map(
    (serialized.pendingWithdrawals || []).map((item: any) => [
      item.requestId,
      deserializeWithdrawal(item.withdrawal),
    ])
  );

  // Convert requestedRebalance array back to Map
  const requestedRebalance = new Map(
    (serialized.requestedRebalance || []).map((item: any) => [item.tokenId, BigInt(item.amount)])
  );

  return {
    counterpartyEntityId: serialized.counterpartyEntityId,
    mempool: serialized.mempool,
    currentFrame: deserializeAccountFrame(serialized.currentFrame),
    sentTransitions: serialized.sentTransitions,
    ackedTransitions: serialized.ackedTransitions,
    deltas,
    globalCreditLimits: serialized.globalCreditLimits
      ? {
          ownLimit: BigInt(serialized.globalCreditLimits.ownLimit),
          peerLimit: BigInt(serialized.globalCreditLimits.peerLimit),
        }
      : undefined,
    currentHeight: serialized.currentHeight,
    pendingFrame: serialized.pendingFrame
      ? deserializeAccountFrame(serialized.pendingFrame)
      : undefined,
    pendingSignatures: serialized.pendingSignatures,
    rollbackCount: serialized.rollbackCount,
    sendCounter: serialized.sendCounter,
    receiveCounter: serialized.receiveCounter,
    proofHeader: serialized.proofHeader,
    proofBody: serialized.proofBody
      ? {
          tokenIds: serialized.proofBody.tokenIds,
          deltas: serialized.proofBody.deltas.map((d: string) => BigInt(d)),
        }
      : undefined,
    hankoSignature: serialized.hankoSignature,
    frameHistory: serialized.frameHistory.map(deserializeAccountFrame),
    pendingForward: serialized.pendingForward
      ? {
          tokenId: serialized.pendingForward.tokenId,
          amount: BigInt(serialized.pendingForward.amount),
          route: serialized.pendingForward.route,
          description: serialized.pendingForward.description,
        }
      : undefined,
    pendingWithdrawals,
    requestedRebalance,
  };
}

/**
 * Serialize AccountFrame (handles deltas BigInt[])
 */
function serializeAccountFrame(frame: any): any {
  return {
    height: frame.height,
    timestamp: frame.timestamp,
    accountTxs: frame.accountTxs,
    prevFrameHash: frame.prevFrameHash,
    stateHash: frame.stateHash,
    tokenIds: frame.tokenIds,
    deltas: frame.deltas.map((d: bigint) => d.toString()),
    fullDeltaStates: frame.fullDeltaStates
      ? frame.fullDeltaStates.map(serializeDelta)
      : undefined,
  };
}

/**
 * Deserialize AccountFrame
 */
function deserializeAccountFrame(serialized: any): any {
  return {
    height: serialized.height,
    timestamp: serialized.timestamp,
    accountTxs: serialized.accountTxs,
    prevFrameHash: serialized.prevFrameHash,
    stateHash: serialized.stateHash,
    tokenIds: serialized.tokenIds,
    deltas: serialized.deltas.map((d: string) => BigInt(d)),
    fullDeltaStates: serialized.fullDeltaStates
      ? serialized.fullDeltaStates.map(deserializeDelta)
      : undefined,
  };
}

/**
 * Serialize Delta (all BigInt fields)
 */
function serializeDelta(delta: any): any {
  return {
    tokenId: delta.tokenId,
    collateral: delta.collateral.toString(),
    ondelta: delta.ondelta.toString(),
    offdelta: delta.offdelta.toString(),
    leftCreditLimit: delta.leftCreditLimit.toString(),
    rightCreditLimit: delta.rightCreditLimit.toString(),
    leftAllowance: delta.leftAllowance.toString(),
    rightAllowance: delta.rightAllowance.toString(),
  };
}

/**
 * Deserialize Delta
 */
function deserializeDelta(serialized: any): any {
  return {
    tokenId: serialized.tokenId,
    collateral: BigInt(serialized.collateral),
    ondelta: BigInt(serialized.ondelta),
    offdelta: BigInt(serialized.offdelta),
    leftCreditLimit: BigInt(serialized.leftCreditLimit),
    rightCreditLimit: BigInt(serialized.rightCreditLimit),
    leftAllowance: BigInt(serialized.leftAllowance),
    rightAllowance: BigInt(serialized.rightAllowance),
  };
}

/**
 * Serialize Withdrawal
 */
function serializeWithdrawal(withdrawal: any): any {
  return {
    requestId: withdrawal.requestId,
    tokenId: withdrawal.tokenId,
    amount: withdrawal.amount.toString(),
    requestedAt: withdrawal.requestedAt,
    direction: withdrawal.direction,
    status: withdrawal.status,
    signature: withdrawal.signature,
  };
}

/**
 * Deserialize Withdrawal
 */
function deserializeWithdrawal(serialized: any): any {
  return {
    requestId: serialized.requestId,
    tokenId: serialized.tokenId,
    amount: BigInt(serialized.amount),
    requestedAt: serialized.requestedAt,
    direction: serialized.direction,
    status: serialized.status,
    signature: serialized.signature,
  };
}

/**
 * Save replay to JSON file (for Node.js/Bun environments)
 * Browser environments should use downloadReplayJSON() instead
 */
export function saveReplayToFile(history: EnvSnapshot[], filename: string): string {
  const exported = exportReplay(history);
  const json = safeStringify(exported);

  // For Bun/Node environments
  if (typeof Bun !== 'undefined') {
    Bun.write(filename, json);
  } else if (typeof require !== 'undefined') {
    require('fs').writeFileSync(filename, json);
  } else {
    throw new Error('saveReplayToFile requires Node.js or Bun runtime');
  }

  return filename;
}

/**
 * Load replay from JSON file (for Node.js/Bun environments)
 */
export function loadReplayFromFile(filename: string): EnvSnapshot[] {
  let json: string;

  // For Bun/Node environments
  if (typeof Bun !== 'undefined') {
    json = Bun.file(filename).text();
  } else if (typeof require !== 'undefined') {
    json = require('fs').readFileSync(filename, 'utf-8');
  } else {
    throw new Error('loadReplayFromFile requires Node.js or Bun runtime');
  }

  const data = JSON.parse(json) as ReplayExport;
  return importReplay(data);
}

/**
 * Generate downloadable JSON blob for browser
 * Returns data URL that can be used with <a download>
 */
export function downloadReplayJSON(history: EnvSnapshot[], filename: string = 'replay.json'): string {
  const exported = exportReplay(history);
  const json = safeStringify(exported);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  // Trigger download
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);

  return url;
}
