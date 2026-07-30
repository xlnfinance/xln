import type { EntityTx } from '../../types/entity-tx';
import {
  type EntityTxDataSchema,
  validateEntityTxDataFields,
} from './fields';
import { ENTITY_TX_CROSS_J_SCHEMAS } from './cross-j-schemas';
import { ENTITY_TX_OPERATION_SCHEMAS } from './operation-schemas';
import { ENTITY_TX_PAYMENT_SCHEMAS } from './payment-schemas';

const ENTITY_TX_SIMPLE_SCHEMAS = {
  ...ENTITY_TX_PAYMENT_SCHEMAS,
  ...ENTITY_TX_CROSS_J_SCHEMAS,
  ...ENTITY_TX_OPERATION_SCHEMAS,
} as const;

export type SimpleEntityTxType = keyof typeof ENTITY_TX_SIMPLE_SCHEMAS;

type SpecializedEntityTxType =
  | 'accountInput'
  | 'chat'
  | 'consensusOutput'
  | 'entityCommand'
  | 'htlcOnionAdvance'
  | 'htlcPayment'
  | 'materializeCrossJurisdictionClear'
  | 'materializeCrossJurisdictionSwap'
  | 'propose'
  | 'reissueCertifiedOutput'
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
};
