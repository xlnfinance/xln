import type { EntityInput } from '../../entity/types';
import type { RoutedEntityInput, RuntimeReplica } from '../types';
import { encodeCanonicalConsensusBytes } from '../../protocol/serialization/binary-codec';
import { keccakBytesHash } from '../../protocol/crypto/keccak-text';

export const isLocalRuntimeOutput = (env: RuntimeReplica, output: RoutedEntityInput): boolean => {
  const runtimeId = env.runtimeId?.toLowerCase();
  return Boolean(runtimeId) && output.runtimeId?.toLowerCase() === runtimeId;
};

const recipient = (input: EntityInput): string =>
  `${input.entityId.toLowerCase()}:${input.signerId.toLowerCase()}`;

/** Transport metadata may change during merge; signed payload bytes may not.
 * Index each payload separately because a frame cap can split one tx lane,
 * and Entity admission merges lanes for the same recipient. No receipt is
 * persisted: this index is rebuilt from the current accepted inputs only.
 */
const payloadKeys = (input: EntityInput): string[] => {
  const payloads: unknown[] = (input.entityTxs ?? []).map(tx => ['tx', tx]);
  if (input.proposedFrame) payloads.push(['frame', input.proposedFrame]);
  if (input.leaderTimeoutVote) payloads.push(['leader', input.leaderTimeoutVote]);
  for (const [signer, signatures] of input.hashPrecommits ?? []) {
    for (const signature of signatures) payloads.push(['precommit', input.hashPrecommitFrame, signer, signature]);
  }
  for (const [signer, attestation] of input.jPrefixAttestations ?? []) {
    payloads.push(['j-prefix', signer, attestation]);
  }
  return payloads.map(value => keccakBytesHash(encodeCanonicalConsensusBytes(value)));
};

export const localOutputIncludedIn = (inputs: readonly EntityInput[], outputs: readonly RoutedEntityInput[]) => {
  const recipients = new Set(outputs.map(recipient));
  const included = new Map<string, Set<string>>();
  for (const input of inputs) {
    const key = recipient(input);
    if (!recipients.has(key)) continue;
    const payloads = included.get(key) ?? new Set<string>();
    for (const payload of payloadKeys(input)) payloads.add(payload);
    included.set(key, payloads);
  }
  return (output: RoutedEntityInput): boolean => {
    const payloads = included.get(recipient(output));
    return payloads !== undefined && payloadKeys(output).every(key => payloads.has(key));
  };
};

/** Only authenticated, applied recipient inputs retire a local output. Merely
 * enqueuing an ACK is insufficient: a later capped frame can defer it again.
 */
export const retireAppliedLocalOutputs = (env: RuntimeReplica, inputs: readonly EntityInput[]): void => {
  const pending = env.pendingNetworkOutputs;
  if (!pending) return;
  const local = pending.filter(output => isLocalRuntimeOutput(env, output));
  if (local.length === 0) return;
  const applied = localOutputIncludedIn(inputs, local);
  env.pendingNetworkOutputs = pending.filter(output =>
    !isLocalRuntimeOutput(env, output) || !applied(output));
};
