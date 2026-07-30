import type { AccountTx } from '../../types/account';
import {
  type AccountTxDataSchema,
  validateAccountTxDataFields,
} from './fields';
import { ACCOUNT_TX_LENDING_SCHEMAS } from './lending-schemas';
import { ACCOUNT_TX_PAYMENT_SCHEMAS } from './payment-schemas';
import {
  type AccountFrameDecoder,
  validateSpecialAccountTxData,
} from './special';
import {
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../protocol/boundary-validation';

const ACCOUNT_TX_SIMPLE_SCHEMAS = {
  ...ACCOUNT_TX_PAYMENT_SCHEMAS,
  ...ACCOUNT_TX_LENDING_SCHEMAS,
} as const;

type SimpleAccountTxType = keyof typeof ACCOUNT_TX_SIMPLE_SCHEMAS;
type SpecialAccountTxType =
  | 'account_frame'
  | 'cross_pull_close'
  | 'htlc_lock'
  | 'htlc_resolve'
  | 'j_event_claim'
  | 'settle_transition';

type MissingAccountTxType = Exclude<
  AccountTx['type'],
  SimpleAccountTxType | SpecialAccountTxType
>;
type ExtraAccountTxType = Exclude<
  SimpleAccountTxType | SpecialAccountTxType,
  AccountTx['type']
>;
const ACCOUNT_TX_TYPES_ARE_EXHAUSTIVE: MissingAccountTxType extends never
  ? ExtraAccountTxType extends never
    ? true
    : never
  : never = true;
void ACCOUNT_TX_TYPES_ARE_EXHAUSTIVE;

const isSimpleAccountTxType = (
  type: string,
): type is SimpleAccountTxType => Object.hasOwn(ACCOUNT_TX_SIMPLE_SCHEMAS, type);

function assertDecodedAccountTx(
  value: unknown,
  code: string,
  decodeFrame: AccountFrameDecoder,
): asserts value is AccountTx {
  const tx = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(tx, ['type', 'data'], [], `${code}_FIELDS`);
  const type = tx['type'];
  if (typeof type !== 'string') throw new Error(`${code}_TYPE`);
  requireBoundaryRecord(tx['data'], `${code}_DATA`);
  if (validateSpecialAccountTxData(type, tx['data'], `${code}_DATA`, decodeFrame)) return;
  if (!isSimpleAccountTxType(type)) throw new Error(`${code}_TYPE_UNKNOWN:${type}`);
  const schema: AccountTxDataSchema = ACCOUNT_TX_SIMPLE_SCHEMAS[type];
  validateAccountTxDataFields(tx['data'], schema, `${code}_DATA`);
}

export const decodeAccountTx = (
  value: unknown,
  code: string,
  decodeFrame: AccountFrameDecoder,
): AccountTx => {
  assertDecodedAccountTx(value, code, decodeFrame);
  return value;
};

export const decodeAccountTxs = (
  value: unknown,
  code: string,
  decodeFrame: AccountFrameDecoder,
): AccountTx[] => {
  if (!Array.isArray(value)) throw new Error(code);
  return value.map((tx, index) => decodeAccountTx(tx, `${code}_${index}`, decodeFrame));
};
