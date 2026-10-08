import { ethers } from 'ethers';
import { decodeSignedTronTransaction } from './tron-transaction';
import type { TronExpiryEvidence } from './tron-authority';

/** RPC-attested expiry authorizes a new envelope for precisely the same signed
 * call. It does not prove absence cryptographically or change the payer. */
export const validateTronReplacement = (oldRaw: string, raw: string, previousHash: string, evidence: TronExpiryEvidence): void => {
  if (raw !== raw.toLowerCase()) throw new Error('TRON_REPLACEMENT_WIRE_NON_CANONICAL');
  const next = decodeSignedTronTransaction(raw);
  if (!ethers.isHexString(previousHash, 32) || previousHash !== previousHash.toLowerCase()
    || evidence.oldTransactionHash !== previousHash || next.hash === previousHash) throw new Error('TRON_REPLACEMENT_PREVIOUS_HASH_MISMATCH');
  if (!Number.isSafeInteger(evidence.blockNumber) || evidence.blockNumber <= 0
    || !Number.isSafeInteger(evidence.timestamp) || evidence.timestamp <= 0
    || !ethers.isHexString(evidence.blockHash, 32) || evidence.blockHash !== evidence.blockHash.toLowerCase()
    || BigInt(`0x${evidence.blockHash.slice(2, 18)}`) !== BigInt(evidence.blockNumber)
    || next.timestamp < BigInt(evidence.timestamp) || next.expiration <= BigInt(evidence.timestamp)) throw new Error('TRON_REPLACEMENT_EXPIRY_EVIDENCE_INVALID');
  if (oldRaw === raw) return;
  const old = decodeSignedTronTransaction(oldRaw);
  if (old.hash !== previousHash) throw new Error('TRON_REPLACEMENT_PREVIOUS_HASH_MISMATCH');
  if (BigInt(evidence.timestamp) <= old.expiration) throw new Error('TRON_REPLACEMENT_EXPIRY_EVIDENCE_INVALID');
  if (old.from !== next.from || old.to !== next.to || old.value !== next.value || old.data !== next.data) throw new Error('TRON_REPLACEMENT_INTENT_MISMATCH');
};
