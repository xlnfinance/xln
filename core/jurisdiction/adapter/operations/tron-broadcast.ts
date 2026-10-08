import { decodeSignedTronTransaction } from './tron-transaction';
import type { TronWeb, Types } from 'tronweb';

/** Broadcast the exact signed protobuf payload, including TAPOS and expiration.
 * JSON broadcast rejects deeply nested ABI metadata before TVM execution. The
 * hex API accepts the same native transaction; it must not change its digest
 * or omit signatures while converting the transport representation. */
export const encodeSignedTronTransaction = (tronWeb: TronWeb, signed: Types.SignedTransaction): string => {
  if (signed.signature.length === 0) throw new Error('TRON_TRANSACTION_SIGNATURE_MISSING');
  const codec = tronWeb.utils.transaction;
  const protobuf = codec.txJsonToPb(signed);
  if (codec.txPbToRawDataHex(protobuf).toLowerCase() !== signed.raw_data_hex.toLowerCase()
    || codec.txPbToTxID(protobuf).replace(/^0x/, '').toLowerCase() !== signed.txID.toLowerCase()) {
    throw new Error('TRON_BROADCAST_SIGNED_PAYLOAD_MISMATCH');
  }
  for (const signature of signed.signature) {
    if (!/^[0-9a-fA-F]{130}$/.test(signature)) throw new Error('TRON_TRANSACTION_SIGNATURE_INVALID');
    protobuf.addSignature(Uint8Array.from(Buffer.from(signature, 'hex')));
  }
  return Buffer.from(protobuf.serializeBinary()).toString('hex');
};

export const broadcastTronTransaction = (tronWeb: TronWeb, signed: Types.SignedTransaction) =>
  tronWeb.trx.sendHexTransaction(encodeSignedTronTransaction(tronWeb, signed));


export const broadcastSignedTronWire = async (tronWeb: TronWeb, rawTransaction: string): Promise<string> => {
  const decoded = decodeSignedTronTransaction(rawTransaction);
  const broadcast = await tronWeb.trx.sendHexTransaction(rawTransaction.slice(2));
  // An exact-byte replay is idempotent; it never prepares a second transaction.
  if (!broadcast.result && broadcast.code !== 'DUP_TRANSACTION_ERROR') {
    if (broadcast.code === 'TRANSACTION_EXPIRATION_ERROR') {
      throw new Error('transaction was not mined: TRON_PREPARED_EXPIRATION_REQUIRES_RECONCILIATION');
    }
    throw new Error(`TRON_PREPARED_BROADCAST_FAILED:${broadcast.code ?? 'unknown'}`);
  }
  if (broadcast.result && `0x${broadcast.txid}`.toLowerCase() !== decoded.hash) {
    throw new Error('TRON_PREPARED_BROADCAST_HASH_MISMATCH');
  }
  return decoded.hash;
};
