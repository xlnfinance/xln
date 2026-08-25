import { buffersEqual } from '../protocol/serialization';
import { encodeAccountStateValue } from '../account/commitment/account-state-value';
import { rscoreCheckpointList, rscoreCheckpointTuple } from './checkpoint-wire';

const MAX_CANONICAL_DEPTH = 32;

const fail = (field: string): never => {
  throw new Error(`RSCORE_CHECKPOINT_${field}`);
};

const canonicalInteger = (value: unknown, field: string): number => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint' && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER))
    return Number(value);
  return fail(`${field}_INTEGER`);
};

const canonicalText = (value: unknown, field: string): string =>
  typeof value === 'string' ? value : fail(`${field}_TEXT`);

const encodedIdentity = (value: unknown): string => Buffer.from(encodeAccountStateValue(value)).toString('hex');

/** Strict inverse of rscore's nine-variant CanonicalValue wire format. */
export const decodeRscoreCanonicalValue = (value: unknown, field: string, depth = 0): unknown => {
  if (depth > MAX_CANONICAL_DEPTH) return fail(`${field}_DEPTH`);
  const row = rscoreCheckpointList(value, `${field}_VALUE`);
  const tag = canonicalInteger(row[0], `${field}_TAG`);
  const nested = (entry: unknown, suffix: string): unknown =>
    decodeRscoreCanonicalValue(entry, `${field}_${suffix}`, depth + 1);
  switch (tag) {
    case 0:
      if (row.length !== 1) return fail(`${field}_NULL_ARITY`);
      return null;
    case 1: {
      const tuple = rscoreCheckpointTuple(row, 2, `${field}_BOOL`);
      const flag = canonicalInteger(tuple[1], `${field}_BOOL`);
      if (flag !== 0 && flag !== 1) return fail(`${field}_BOOL_FLAG`);
      return flag === 1;
    }
    case 2: {
      const tuple = rscoreCheckpointTuple(row, 2, `${field}_NUMBER`);
      const raw = canonicalText(tuple[1], `${field}_NUMBER`);
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || String(parsed) !== raw) return fail(`${field}_NUMBER_CANONICAL`);
      return parsed;
    }
    case 3: {
      const tuple = rscoreCheckpointTuple(row, 2, `${field}_BIGINT`);
      const raw = canonicalText(tuple[1], `${field}_BIGINT`);
      if (!/^(0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(raw)) return fail(`${field}_BIGINT_CANONICAL`);
      return BigInt(raw);
    }
    case 4:
      return canonicalText(rscoreCheckpointTuple(row, 2, `${field}_STRING`)[1], `${field}_STRING`);
    case 5:
      return rscoreCheckpointList(rscoreCheckpointTuple(row, 2, `${field}_ARRAY`)[1], `${field}_ARRAY`).map(
        (entry, index) => nested(entry, `ARRAY_${index}`),
      );
    case 6: {
      const entries = rscoreCheckpointList(rscoreCheckpointTuple(row, 2, `${field}_MAP`)[1], `${field}_MAP`).map(
        (entry, index) => {
          const pair = rscoreCheckpointTuple(entry, 2, `${field}_MAP_${index}`);
          return [nested(pair[0], `MAP_${index}_KEY`), nested(pair[1], `MAP_${index}_VALUE`)] as const;
        },
      );
      const identities = entries.map(([key]) => encodedIdentity(key));
      if (new Set(identities).size !== identities.length) return fail(`${field}_MAP_DUPLICATE`);
      return new Map(entries);
    }
    case 7: {
      const entries = rscoreCheckpointList(rscoreCheckpointTuple(row, 2, `${field}_SET`)[1], `${field}_SET`).map(
        (entry, index) => nested(entry, `SET_${index}`),
      );
      const identities = entries.map(encodedIdentity);
      if (new Set(identities).size !== identities.length) return fail(`${field}_SET_DUPLICATE`);
      return new Set(entries);
    }
    case 8: {
      const entries = rscoreCheckpointList(rscoreCheckpointTuple(row, 2, `${field}_OBJECT`)[1], `${field}_OBJECT`).map(
        (entry, index) => {
          const pair = rscoreCheckpointTuple(entry, 2, `${field}_OBJECT_${index}`);
          return [
            canonicalText(pair[0], `${field}_OBJECT_${index}_KEY`),
            nested(pair[1], `OBJECT_${index}_VALUE`),
          ] as const;
        },
      );
      const keys = entries.map(([key]) => key);
      if (new Set(keys).size !== keys.length) return fail(`${field}_OBJECT_DUPLICATE`);
      return Object.fromEntries(entries);
    }
    default:
      return fail(`${field}_TAG_UNKNOWN`);
  }
};

export const assertSameRscoreCanonicalValue = (actual: unknown, expected: unknown, field: string): void => {
  if (!buffersEqual(Buffer.from(encodeAccountStateValue(actual)), Buffer.from(encodeAccountStateValue(expected))))
    fail(`${field}_MISMATCH`);
};
