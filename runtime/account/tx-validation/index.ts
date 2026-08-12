import type { AccountTx } from '../../types/account';
import {
  type AccountTxDataSchema,
  validateAccountTxDataFields,
} from './fields';
import { ACCOUNT_TX_LENDING_SCHEMAS } from './lending-schemas';
import { ACCOUNT_TX_PAYMENT_SCHEMAS } from './payment-schemas';
import {
  validateSpecialAccountTxData,
} from './special';
import {
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../protocol/boundary-validation';
import { TOKENS } from '../../config/constants';

const ACCOUNT_TX_SIMPLE_SCHEMAS = {
  ...ACCOUNT_TX_PAYMENT_SCHEMAS,
  ...ACCOUNT_TX_LENDING_SCHEMAS,
} as const;

type SimpleAccountTxType = keyof typeof ACCOUNT_TX_SIMPLE_SCHEMAS;
type SpecialAccountTxType =
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
): asserts value is AccountTx {
  const tx = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(tx, ['type', 'data'], [], `${code}_FIELDS`);
  const type = tx['type'];
  if (typeof type !== 'string') throw new Error(`${code}_TYPE`);
  const data = requireBoundaryRecord(tx['data'], `${code}_DATA`);
  if (validateSpecialAccountTxData(type, data, `${code}_DATA`)) return;
  if (!isSimpleAccountTxType(type)) throw new Error(`${code}_TYPE_UNKNOWN:${type}`);
  const schema: AccountTxDataSchema = ACCOUNT_TX_SIMPLE_SCHEMAS[type];
  validateAccountTxDataFields(data, schema, `${code}_DATA`);
  if (type === 'add_delta') {
    const tokenId = data['tokenId'];
    if (typeof tokenId !== 'number' || tokenId < 0 || tokenId > TOKENS.MAX_TOKEN_ID) {
      throw new Error(`${code}_DATA_TOKENID_DOMAIN`);
    }
  }
}

export const decodeAccountTx = (
  value: unknown,
  code: string,
): AccountTx => {
  assertDecodedAccountTx(value, code);
  return value;
};

export const decodeAccountTxs = (
  value: unknown,
  code: string,
): AccountTx[] => {
  if (!Array.isArray(value)) throw new Error(code);
  return value.map((tx, index) => decodeAccountTx(tx, `${code}_${index}`));
};
