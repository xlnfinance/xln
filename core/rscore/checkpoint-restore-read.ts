import { rscoreCheckpointBytes, rscoreCheckpointTuple } from './checkpoint-wire';

export const checkpointRestoreFail = (field: string): never => {
  throw new Error(`RSCORE_CHECKPOINT_RESTORE_${field}`);
};

export const checkpointSafeInt = (value: unknown, field: string): number => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  return checkpointRestoreFail(`${field}_INTEGER`);
};

export const checkpointUint64 = (value: unknown, field: string): bigint => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'bigint' && value >= 0n && value <= 0xffff_ffff_ffff_ffffn) return value;
  return checkpointRestoreFail(`${field}_UINT64`);
};

export const checkpointUint32 = (value: unknown, field: string): number => {
  const parsed = checkpointSafeInt(value, field);
  if (parsed > 0xffff_ffff) return checkpointRestoreFail(`${field}_UINT32`);
  return parsed;
};

export const checkpointTokenId = (value: unknown, field: string): number => {
  const parsed = checkpointSafeInt(value, field);
  if (parsed > 65_535) return checkpointRestoreFail(`${field}_TOKEN_ID`);
  return parsed;
};

export const checkpointText = (value: unknown, field: string): string =>
  typeof value === 'string' ? value : checkpointRestoreFail(`${field}_TEXT`);

export const checkpointBool = (value: unknown, field: string): boolean =>
  typeof value === 'boolean' ? value : checkpointRestoreFail(`${field}_BOOL`);

export const checkpointFlag = (value: unknown, field: string): boolean => {
  const parsed = checkpointSafeInt(value, field);
  if (parsed !== 0 && parsed !== 1) return checkpointRestoreFail(`${field}_FLAG`);
  return parsed === 1;
};

export const checkpointBigInt = (value: unknown, field: string): bigint => {
  const raw = checkpointText(value, field);
  if (!/^(0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(raw)) {
    return checkpointRestoreFail(`${field}_BIGINT`);
  }
  return BigInt(raw);
};

export const checkpointHex = (value: unknown, length: number, field: string): string =>
  `0x${Buffer.from(rscoreCheckpointBytes(value, length, `RESTORE_${field}`)).toString('hex')}`;

export const checkpointOptionalHex = (value: unknown, length: number, field: string): string | undefined =>
  value === null ? undefined : checkpointHex(value, length, field);

export const checkpointHanko = (value: unknown, field: string): string => {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    return checkpointRestoreFail(`${field}_HANKO`);
  }
  return `0x${Buffer.from(value).toString('hex')}`;
};

export const checkpointOptionalHanko = (value: unknown, field: string): string | undefined =>
  value === null ? undefined : checkpointHanko(value, field);

export const checkpointOptionalTuple = (
  value: unknown,
  arity: number,
  field: string,
): ReturnType<typeof rscoreCheckpointTuple> | undefined =>
  value === null ? undefined : rscoreCheckpointTuple(value, arity, `RESTORE_${field}`);
