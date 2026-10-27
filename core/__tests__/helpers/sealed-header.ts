import { ethereumHeaderHash } from '../../jurisdiction/adapter/rpc/state-anchor/rpc-header-hash';

const word = (byte: string): string => `0x${byte.repeat(32)}`;

/**
 * An eth_getBlockByNumber(…, false) object whose `hash` is keccak256(RLP) of
 * its own fields, as the receipt reader now requires. Fields left out take
 * fixed values; `extraData` distinguishes otherwise equal fork siblings. An
 * omitted stateRoot is hashed as zero and then dropped from the object.
 */
export const sealedHeader = (fields: {
  number: number;
  parentHash: string;
  stateRoot?: string;
  receiptsRoot?: string;
  logsBloom?: string;
  extraData?: string;
}) => {
  const header: Record<string, unknown> = {
    parentHash: fields.parentHash,
    sha3Uncles: word('00'),
    miner: `0x${'00'.repeat(20)}`,
    stateRoot: fields.stateRoot ?? word('00'),
    transactionsRoot: word('00'),
    receiptsRoot: fields.receiptsRoot ?? word('00'),
    logsBloom: fields.logsBloom ?? `0x${'00'.repeat(256)}`,
    difficulty: '0x0',
    number: `0x${fields.number.toString(16)}`,
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    timestamp: `0x${fields.number.toString(16)}`,
    extraData: fields.extraData ?? '0x',
    mixHash: word('00'),
    nonce: '0x0000000000000000',
    baseFeePerGas: '0x7',
    transactions: [] as string[],
  };
  header['hash'] = ethereumHeaderHash(header);
  if (fields.stateRoot === undefined) delete header['stateRoot'];
  return header as Record<string, unknown> & { hash: string; parentHash: string; number: string; logsBloom: string };
};
