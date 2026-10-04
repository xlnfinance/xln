// An EIP-1559 transaction as a node takes it: the fields, the key's signature over their hash, and the raw bytes that
// `eth_sendRawTransaction` accepts. The one key that signs batches also sends them, so the Host needs no wallet. Never
// anything but a call to a contract with no value and no access list: that is all the J path sends.
import { rlp } from "../../../kernel/encoding/rlp.ts";
import { signDigest } from "../../../kernel/crypto/signature.ts";
import {
  bytesToHex, concat, hexToBytes, keccak256, minimalBytes, type HexFault,
} from "../../../kernel/encoding/bytes.ts";
import { flatMap, map, type Result } from "../../../kernel/core/result.ts";

export type Tx = Readonly<{
  chainId: bigint; nonce: bigint; tip: bigint; maxFee: bigint; gas: bigint; to: string; data: string;
}>;

const TYPE = Uint8Array.of(2);
const NOTHING = new Uint8Array(0);
const NO_ACCESS_LIST: readonly Uint8Array[] = [];

/** RLP counts an integer as its big-endian bytes without leading zeros, so zero is no bytes at all. */
const scalar = (n: bigint): Uint8Array => (n === 0n ? NOTHING : minimalBytes(n));

const fieldsOf = (tx: Tx, to: Uint8Array, data: Uint8Array) =>
  [scalar(tx.chainId), scalar(tx.nonce), scalar(tx.tip), scalar(tx.maxFee), scalar(tx.gas), to, NOTHING, data,
    NO_ACCESS_LIST] as const;

/** The signed transaction as hex text, or the field that is not hex. */
export const rawTx = (tx: Tx, secret: Uint8Array): Result<string, HexFault> =>
  flatMap(hexToBytes(tx.to), (to) => map(hexToBytes(tx.data), (data) => {
    const fields = fieldsOf(tx, to, data);
    const signature = signDigest(keccak256(concat([TYPE, rlp(fields)])), secret);
    const signed = [...fields, scalar(BigInt(signature.recovery)), scalar(signature.r), scalar(signature.s)];
    return bytesToHex(concat([TYPE, rlp(signed)]));
  }));
