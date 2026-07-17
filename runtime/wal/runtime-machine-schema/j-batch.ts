import {
  requireArray,
  requireBigInt,
  requireBoolean,
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireString,
} from './primitives';

type FieldValidator = (value: unknown, code: string) => unknown;

const validateRecordArray = (
  value: unknown,
  code: string,
  fields: Record<string, FieldValidator>,
): void => {
  for (const [index, raw] of requireArray(value, code).entries()) {
    const itemCode = `${code}_${index}`;
    const item = requireBoundaryRecord(raw, itemCode);
    const keys = Object.keys(fields);
    requireExactBoundaryKeys(item, keys, [], `${itemCode}_FIELDS`);
    for (const key of keys) fields[key]!(item[key], `${itemCode}_${key.toUpperCase()}`);
  }
};

const integer: FieldValidator = (value, code) => requireBoundaryInteger(value, code);
const bigint: FieldValidator = (value, code) => requireBigInt(value, code);
const string: FieldValidator = (value, code) => requireString(value, code);
const bool: FieldValidator = (value, code) => requireBoolean(value, code);

const validateProofBody = (value: unknown, code: string): void => {
  const proof = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(proof, ['watchSeed', 'offdeltas', 'tokenIds', 'transformers'], [], `${code}_FIELDS`);
  requireString(proof['watchSeed'], `${code}_WATCH_SEED`);
  requireArray(proof['offdeltas'], `${code}_OFFDELTAS`).forEach((entry, index) =>
    requireBigInt(entry, `${code}_OFFDELTAS_${index}`));
  requireArray(proof['tokenIds'], `${code}_TOKEN_IDS`).forEach((entry, index) =>
    requireBigInt(entry, `${code}_TOKEN_IDS_${index}`, 0n));
  validateRecordArray(proof['transformers'], `${code}_TRANSFORMERS`, {
    transformerAddress: string,
    encodedBatch: string,
    allowances: (allowances, allowanceCode) => validateRecordArray(allowances, allowanceCode, {
      deltaIndex: bigint,
      rightAllowance: bigint,
      leftAllowance: bigint,
    }),
  });
};

export const validateJBatch = (value: unknown, code: string): void => {
  const batch = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(batch, [
    'reserveToExternalToken', 'externalTokenToReserve', 'reserveToReserve',
    'reserveToCollateral', 'collateralToReserve', 'settlements', 'disputeStarts',
    'disputeFinalizations', 'flashloans', 'revealSecrets', 'hub_id',
  ], [], `${code}_FIELDS`);
  validateRecordArray(batch['reserveToExternalToken'], `${code}_R2E`, {
    receivingEntity: string, tokenId: integer, amount: bigint,
  });
  validateRecordArray(batch['externalTokenToReserve'], `${code}_E2R`, {
    entity: string, contractAddress: string, externalTokenId: bigint, tokenType: integer,
    internalTokenId: integer, amount: bigint,
  });
  validateRecordArray(batch['reserveToReserve'], `${code}_R2R`, {
    receivingEntity: string, tokenId: integer, amount: bigint,
  });
  validateRecordArray(batch['reserveToCollateral'], `${code}_R2C`, {
    tokenId: integer,
    receivingEntity: string,
    pairs: (pairs, pairsCode) => validateRecordArray(pairs, pairsCode, { entity: string, amount: bigint }),
  });
  validateRecordArray(batch['collateralToReserve'], `${code}_C2R`, {
    counterparty: string, tokenId: integer, amount: bigint, nonce: integer, sig: string,
  });
  validateRecordArray(batch['settlements'], `${code}_SETTLEMENTS`, {
    leftEntity: string,
    rightEntity: string,
    diffs: (diffs, diffsCode) => validateRecordArray(diffs, diffsCode, {
      tokenId: integer, leftDiff: bigint, rightDiff: bigint, collateralDiff: bigint, ondeltaDiff: bigint,
    }),
    forgiveDebtsInTokenIds: (ids, idsCode) => requireArray(ids, idsCode).forEach((id, index) =>
      requireBoundaryInteger(id, `${idsCode}_${index}`)),
    sig: string,
    entityProvider: string,
    hankoData: string,
    nonce: integer,
  });
  validateRecordArray(batch['disputeStarts'], `${code}_DISPUTE_STARTS`, {
    counterentity: string, nonce: integer, proofbodyHash: string, initialProofbody: validateProofBody,
    watchSeed: string, sig: string, starterInitialArguments: string, starterIncrementedArguments: string,
  });
  validateRecordArray(batch['disputeFinalizations'], `${code}_DISPUTE_FINALIZATIONS`, {
    counterentity: string, initialNonce: integer, finalNonce: integer, initialProofbodyHash: string,
    finalProofbody: validateProofBody, starterArguments: string, otherArguments: string, sig: string,
    startedByLeft: bool, cooperative: bool,
  });
  validateRecordArray(batch['flashloans'], `${code}_FLASHLOANS`, { tokenId: integer, amount: bigint });
  validateRecordArray(batch['revealSecrets'], `${code}_REVEAL_SECRETS`, { transformer: string, secret: string });
  requireBoundaryInteger(batch['hub_id'], `${code}_HUB_ID`);
};
