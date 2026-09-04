import {
  requireArray,
  requireBigInt,
  requireBoolean,
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireString,
} from '../../protocol/boundary/boundary-primitives';
import type { JBatch } from './batch';
import { assertMoneyAmount, assertMoneyMagnitude } from '../../protocol/money-cap';

type FieldValidator = (value: unknown, code: string) => unknown;

const validateRecordArray = (
  value: unknown,
  code: string,
  fields: Record<string, FieldValidator>,
  optionalFields: Record<string, FieldValidator> = {},
): unknown[] => {
  const records = requireArray(value, code);
  for (const [index, raw] of records.entries()) {
    const itemCode = `${code}_${index}`;
    const item = requireBoundaryRecord(raw, itemCode);
    const keys = Object.keys(fields);
    const optionalKeys = Object.keys(optionalFields);
    requireExactBoundaryKeys(item, keys, optionalKeys, `${itemCode}_FIELDS`);
    for (const key of keys) {
      item[key] = fields[key]!(item[key], `${itemCode}_${key.toUpperCase()}`);
    }
    for (const key of optionalKeys) {
      if (item[key] !== undefined) {
        item[key] = optionalFields[key]!(item[key], `${itemCode}_${key.toUpperCase()}`);
      }
    }
  }
  return records;
};

const integer: FieldValidator = (value, code) => {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${code}:${value.toString()}`);
    }
    return Number(value);
  }
  return requireBoundaryInteger(value, code);
};
const bigint: FieldValidator = (value, code) => requireBigInt(value, code);
// Contract MAX_MONEY (Types.sol): amounts, allowances and |diffs| above 2^200 revert E8.
const money: FieldValidator = (value, code) => assertMoneyAmount(requireBigInt(value, code), code);
const signedMoney: FieldValidator = (value, code) => assertMoneyMagnitude(requireBigInt(value, code), code);
const string: FieldValidator = (value, code) => requireString(value, code);
const bool: FieldValidator = (value, code) => requireBoolean(value, code);

export const validateProofBody = (value: unknown, code: string): unknown => {
  const proof = requireBoundaryRecord(value, code);
  // These response windows are signed executable dispute policy. Omitting
  // them here would make the RPC watcher reject valid calldata after Solidity
  // accepted it, while accepting the retired unsigned-clock shape on restore.
  requireExactBoundaryKeys(proof, [
    'watchSeed', 'leftResponseSeconds', 'rightResponseSeconds',
    'offdeltas', 'tokenIds', 'transformers',
  ], [], `${code}_FIELDS`);
  requireString(proof['watchSeed'], `${code}_WATCH_SEED`);
  proof['leftResponseSeconds'] = integer(
    proof['leftResponseSeconds'],
    `${code}_LEFT_RESPONSE_SECONDS`,
  );
  proof['rightResponseSeconds'] = integer(
    proof['rightResponseSeconds'],
    `${code}_RIGHT_RESPONSE_SECONDS`,
  );
  proof['offdeltas'] = requireArray(proof['offdeltas'], `${code}_OFFDELTAS`)
    .map((entry, index) => assertMoneyMagnitude(
      requireBigInt(entry, `${code}_OFFDELTAS_${index}`),
      `${code}_OFFDELTAS_${index}`,
    ));
  proof['tokenIds'] = requireArray(proof['tokenIds'], `${code}_TOKEN_IDS`)
    .map((entry, index) =>
      requireBigInt(entry, `${code}_TOKEN_IDS_${index}`, 0n));
  proof['transformers'] = validateRecordArray(
    proof['transformers'],
    `${code}_TRANSFORMERS`,
    {
    transformerAddress: string,
    encodedBatch: string,
    allowances: (allowances, allowanceCode) => validateRecordArray(allowances, allowanceCode, {
      deltaIndex: bigint,
      rightAllowance: money,
      leftAllowance: money,
    }),
    },
  );
  return proof;
};

export function validateJBatch(
  value: unknown,
  code: string,
): asserts value is JBatch {
  const batch = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(batch, [
    'reserveToExternalToken', 'externalTokenToReserve', 'reserveToReserve',
    'reserveToCollateral', 'collateralToReserve', 'settlements', 'disputeStarts', 'counterDisputes',
    'disputeFinalizations', 'revealSecrets', 'hashLadderRegistrations',
  ], [], `${code}_FIELDS`);
  validateRecordArray(batch['reserveToExternalToken'], `${code}_R2E`, {
    receivingEntity: string, tokenId: integer, amount: money,
  });
  validateRecordArray(batch['externalTokenToReserve'], `${code}_E2R`, {
    entity: string, contractAddress: string, externalTokenId: bigint, tokenType: integer,
    internalTokenId: integer, amount: money,
  });
  validateRecordArray(batch['reserveToReserve'], `${code}_R2R`, {
    receivingEntity: string, tokenId: integer, amount: money,
  });
  validateRecordArray(batch['reserveToCollateral'], `${code}_R2C`, {
    tokenId: integer,
    receivingEntity: string,
    pairs: (pairs, pairsCode) => validateRecordArray(pairs, pairsCode, { entity: string, amount: money }),
  });
  validateRecordArray(batch['collateralToReserve'], `${code}_C2R`, {
    counterparty: string, tokenId: integer, amount: money, nonce: integer, sig: string,
  });
  validateRecordArray(batch['settlements'], `${code}_SETTLEMENTS`, {
    leftEntity: string,
    rightEntity: string,
    diffs: (diffs, diffsCode) => validateRecordArray(diffs, diffsCode, {
      tokenId: integer,
      leftDiff: signedMoney,
      rightDiff: signedMoney,
      collateralDiff: signedMoney,
      ondeltaDiff: signedMoney,
    }),
    forgiveDebtsInTokenIds: (ids, idsCode) =>
      requireArray(ids, idsCode).map((id, index) =>
        integer(id, `${idsCode}_${index}`)),
    sig: string,
    nonce: integer,
  });
  validateRecordArray(batch['disputeStarts'], `${code}_DISPUTE_STARTS`, {
    counterentity: string, nonce: integer, proposerIsLeft: bool, proofbodyHash: string, initialProofbody: validateProofBody,
    watchSeed: string, sig: string, starterInitialArguments: string, starterCounterArguments: string,
    starterCounterProofCommitment: string,
  });
  validateRecordArray(batch['counterDisputes'], `${code}_COUNTER_DISPUTES`, {
    counterentity: string,
    initialNonce: integer,
    initialProofbodyHash: string,
    counterNonce: integer,
    proposerIsLeft: bool,
    counterProofbody: validateProofBody,
    sig: string,
  });
  validateRecordArray(batch['disputeFinalizations'], `${code}_DISPUTE_FINALIZATIONS`, {
    counterentity: string, initialNonce: integer, finalNonce: integer, proposerIsLeft: bool, initialProofbodyHash: string,
    finalProofbody: validateProofBody, starterArguments: string, otherArguments: string, sig: string,
    startedByLeft: bool, cooperative: bool,
  }, {
    submitNotBeforeTimestamp: integer,
  });
  validateRecordArray(batch['revealSecrets'], `${code}_REVEAL_SECRETS`, { transformer: string, secret: string });
  validateRecordArray(batch['hashLadderRegistrations'], `${code}_HASH_LADDER_REVEALS`, {
    counterpartyEntity: string,
    targetRole: bool,
    fullHash: string,
    partialRoot: string,
    witness: (witness, witnessCode) => {
      const record = requireBoundaryRecord(witness, witnessCode);
      requireExactBoundaryKeys(
        record,
        ['fillRatio', 'fullSecret', 'reveals'],
        [],
        `${witnessCode}_FIELDS`,
      );
      record['fillRatio'] = integer(record['fillRatio'], `${witnessCode}_FILL_RATIO`);
      requireString(record['fullSecret'], `${witnessCode}_FULL_SECRET`);
      const reveals = requireArray(record['reveals'], `${witnessCode}_REVEALS`);
      if (reveals.length !== 4) throw new Error(`${witnessCode}_REVEALS_LENGTH:${reveals.length}`);
      record['reveals'] = reveals.map((reveal, index) =>
        requireString(reveal, `${witnessCode}_REVEALS_${index}`));
      return record;
    },
  });
}
