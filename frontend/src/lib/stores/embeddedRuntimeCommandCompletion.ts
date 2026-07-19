import { safeStringify } from '@xln/runtime/protocol/serialization';
import type { EnvSnapshot, RuntimeInput } from '@xln/runtime/xln-api';

type RuntimeInputPart = Readonly<{
  kind: string;
  owner: string;
  value: unknown;
  allowDerivedFields?: true;
}>;

const normalizeRef = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const entityOwner = (input: RuntimeInput['entityInputs'][number]): string =>
  `${normalizeRef(input.entityId)}:${normalizeRef(input.signerId)}`;

const entityInputParts = (input: RuntimeInput['entityInputs'][number]): RuntimeInputPart[] => {
  const owner = entityOwner(input);
  const parts: RuntimeInputPart[] = (input.entityTxs ?? []).map((tx) => ({
    kind: 'entityTx',
    owner,
    value: tx,
    ...(tx.type === 'htlcPayment' ? { allowDerivedFields: true as const } : {}),
  }));
  if (input.proposedFrame) parts.push({ kind: 'proposedFrame', owner, value: input.proposedFrame });
  if (input.hashPrecommitFrame || input.hashPrecommits) {
    parts.push({
      kind: 'hashPrecommits',
      owner,
      value: { frame: input.hashPrecommitFrame, signatures: input.hashPrecommits },
    });
  }
  if (input.jPrefixAttestations) {
    parts.push({ kind: 'jPrefixAttestations', owner, value: input.jPrefixAttestations });
  }
  if (input.leaderTimeoutVote) {
    parts.push({ kind: 'leaderTimeoutVote', owner, value: input.leaderTimeoutVote });
  }
  if (parts.length === 0) parts.push({ kind: 'entityWake', owner, value: null });
  return parts;
};

export const embeddedRuntimeInputParts = (input: RuntimeInput): RuntimeInputPart[] => {
  const parts: RuntimeInputPart[] = (input.runtimeTxs ?? []).map((value) => ({
    kind: 'runtimeTx', owner: '', value,
  }));
  for (const entityInput of input.entityInputs ?? []) parts.push(...entityInputParts(entityInput));
  for (const jInput of input.jInputs ?? []) {
    const owner = normalizeRef(jInput.jurisdictionName);
    const jTxs = jInput.jTxs ?? [];
    if (jTxs.length === 0) parts.push({ kind: 'jInput', owner, value: null });
    else for (const value of jTxs) parts.push({ kind: 'jTx', owner, value });
  }
  for (const value of input.reliableReceipts ?? []) {
    parts.push({ kind: 'reliableReceipt', owner: '', value });
  }
  return parts;
};

const derivedEntityTxMatches = (available: unknown, required: unknown): boolean => {
  const candidate = available as { type?: unknown; data?: unknown } | null;
  const target = required as { type?: unknown; data?: unknown } | null;
  if (!candidate || !target || candidate.type !== target.type) return false;
  if (!target.data || typeof target.data !== 'object' || Array.isArray(target.data)) {
    return safeStringify(candidate.data) === safeStringify(target.data);
  }
  if (!candidate.data || typeof candidate.data !== 'object' || Array.isArray(candidate.data)) return false;
  const candidateData = candidate.data as Record<string, unknown>;
  return Object.entries(target.data as Record<string, unknown>).every(
    ([key, value]) => safeStringify(candidateData[key]) === safeStringify(value),
  );
};

const partMatches = (available: RuntimeInputPart, required: RuntimeInputPart): boolean => {
  if (available.kind !== required.kind || available.owner !== required.owner) return false;
  if (required.allowDerivedFields) return derivedEntityTxMatches(available.value, required.value);
  return safeStringify(available.value) === safeStringify(required.value);
};

export const runtimeFrameContainsSubmittedInput = (
  applied: RuntimeInput,
  submitted: RuntimeInput,
): boolean => {
  const available = embeddedRuntimeInputParts(applied);
  const consumed = new Set<number>();
  for (const required of embeddedRuntimeInputParts(submitted)) {
    const index = available.findIndex((candidate, candidateIndex) =>
      !consumed.has(candidateIndex) && partMatches(candidate, required));
    if (index < 0) return false;
    consumed.add(index);
  }
  return consumed.size > 0;
};

export const findCommittedEmbeddedRuntimeInputHeight = (
  history: readonly Pick<EnvSnapshot, 'height' | 'runtimeInput'>[],
  submitted: RuntimeInput,
  afterHeight: number,
): number | null => {
  if (!Number.isSafeInteger(afterHeight) || afterHeight < 0) {
    throw new Error(`EMBEDDED_RUNTIME_COMMAND_BASE_HEIGHT_INVALID:${String(afterHeight)}`);
  }
  let committedHeight: number | null = null;
  for (const frame of history) {
    if (frame.height <= afterHeight || !runtimeFrameContainsSubmittedInput(frame.runtimeInput, submitted)) continue;
    committedHeight = committedHeight === null ? frame.height : Math.min(committedHeight, frame.height);
  }
  return committedHeight;
};

export const findPersistedEmbeddedRuntimeInputHeight = async (
  readFrame: (height: number) => Promise<Pick<EnvSnapshot, 'height' | 'runtimeInput'> | null>,
  submitted: RuntimeInput,
  afterHeight: number,
  throughHeight: number,
): Promise<number | null> => {
  if (!Number.isSafeInteger(afterHeight) || afterHeight < 0) {
    throw new Error(`EMBEDDED_RUNTIME_COMMAND_BASE_HEIGHT_INVALID:${String(afterHeight)}`);
  }
  if (!Number.isSafeInteger(throughHeight) || throughHeight < afterHeight) {
    throw new Error(`EMBEDDED_RUNTIME_COMMAND_SCAN_HEIGHT_INVALID:${String(throughHeight)}`);
  }
  for (let height = afterHeight + 1; height <= throughHeight; height += 1) {
    const frame = await readFrame(height);
    if (frame && runtimeFrameContainsSubmittedInput(frame.runtimeInput, submitted)) return frame.height;
  }
  return null;
};
