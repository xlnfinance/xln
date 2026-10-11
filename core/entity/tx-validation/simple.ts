import type { EntityTx } from '../../types/entity-tx';
import {
  type EntityTxDataSchema,
  validateEntityTxDataFields,
} from './fields';
import { ENTITY_TX_CROSS_J_SCHEMAS } from './cross-j-schemas';
import { ENTITY_TX_OPERATION_SCHEMAS } from './operation-schemas';
import { ENTITY_TX_PAYMENT_SCHEMAS } from './payment-schemas';
import { decodeLendingBankTerms } from '../lending-policy';
import { UINT256_MAX } from '../../protocol/boundary/integer-ranges';
import { requireBoundaryRecord, requireBigInt, requireBoundaryInteger } from '../../protocol/boundary/boundary-primitives';

const ENTITY_TX_SIMPLE_SCHEMAS = {
  ...ENTITY_TX_PAYMENT_SCHEMAS,
  ...ENTITY_TX_CROSS_J_SCHEMAS,
  ...ENTITY_TX_OPERATION_SCHEMAS,
} as const;

export type SimpleEntityTxType = keyof typeof ENTITY_TX_SIMPLE_SCHEMAS;

type SpecializedEntityTxType =
  | 'accountInput'
  | 'boardHandover'
  | 'chat'
  | 'entityCommand'
  | 'htlcPayment'
  | 'materializeCrossJurisdictionClear'
  | 'materializeCrossJurisdictionSwap'
  | 'propose'
  | 'proposeAccountsNow'
  | 'runtimeOutput'
  | 'scheduledWake'
  | 'vote';

type MissingSimpleType = Exclude<
  Exclude<EntityTx['type'], SpecializedEntityTxType>,
  SimpleEntityTxType
>;
type ExtraSimpleType = Exclude<
  SimpleEntityTxType,
  Exclude<EntityTx['type'], SpecializedEntityTxType>
>;
const SIMPLE_TYPES_ARE_EXHAUSTIVE: MissingSimpleType extends never
  ? ExtraSimpleType extends never
    ? true
    : never
  : never = true;
void SIMPLE_TYPES_ARE_EXHAUSTIVE;

export const isSimpleEntityTxType = (
  type: EntityTx['type'],
): type is SimpleEntityTxType => Object.hasOwn(ENTITY_TX_SIMPLE_SCHEMAS, type);

export const validateSimpleEntityTxData = (
  type: SimpleEntityTxType,
  value: unknown,
  code: string,
): void => {
  const schema: EntityTxDataSchema = ENTITY_TX_SIMPLE_SCHEMAS[type];
  validateEntityTxDataFields(value, schema, code);
  if (type === 'lendingSetTerms') decodeLendingBankTerms(value);
  if (type === 'lendingApprove') {
    const data = requireBoundaryRecord(value, code);
    const borrower = data['borrowerEntityId'];
    const amount = requireBigInt(data['maxPrincipal'], 'LENDING_FACILITY_AMOUNT_INVALID', 0n);
    if (amount > UINT256_MAX) throw new Error('LENDING_FACILITY_AMOUNT_INVALID');
    if (typeof borrower !== 'string' || !/^0x[0-9a-f]{64}$/.test(borrower)) throw new Error('LENDING_FACILITY_BORROWER_INVALID');
    requireBoundaryInteger(data['tokenId'], 'LENDING_POLICY_TOKEN_INVALID', 1);
    requireBoundaryInteger(data['expiresAt'], 'LENDING_POLICY_EXPIRY_INVALID', 0);
  }
  if (type === 'directPayment') {
    const data = value as Record<string, unknown>;
    const gateway = data['trustedGatewayEntityId'];
    if (data['deliveryMode'] === 'trusted' && typeof gateway !== 'string') {
      throw new Error(`${code}_TRUSTED_GATEWAY_REQUIRED`);
    }
    if (data['deliveryMode'] === 'direct' && gateway !== undefined) {
      throw new Error(`${code}_DIRECT_GATEWAY_FORBIDDEN`);
    }
  }
};
