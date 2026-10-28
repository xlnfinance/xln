import { ethers } from 'ethers';
import { BATCH_ABI, type ProofBodyStruct } from '../protocol/dispute/proof-body';
import { encodeDeltaTransformerArgs, wrapTransformerArgs } from '../protocol/dispute/arguments';
import { collectKnownDisputeSecretsForHashlocks } from './dispute-arguments';
import type { EntityState } from './types';

const coder = ethers.AbiCoder.defaultAbiCoder();
const batchType = ethers.ParamType.from(BATCH_ABI);
const argumentType = 'tuple(uint16[] fillRatios, bytes32[] secrets)';

// The authenticated body owns clause positions. A retained N8 HTLC can pay
// Alice only if her unpublished preimage reaches the finalizer arguments;
// neither N7 positions nor Bob's start-time arguments authorize that evidence.
export const refreshDisputeSecretArguments = (
  body: ProofBodyStruct,
  existing: string,
  state: EntityState,
  counterparty: string,
  deltaTransformer: string,
): string => {
  const previous: readonly string[] = existing === '0x' ? [] : coder.decode(['bytes[]'], existing)[0];
  let changed = false;
  const clauses = body.transformers.map((clause, index) => {
    const original = previous[index] ?? '0x';
    if (String(clause.transformerAddress).toLowerCase() !== deltaTransformer.toLowerCase()) return original;
    const batch = coder.decode([batchType], clause.encodedBatch)[0];
    const hashlocks = Array.from(batch.payment as readonly { hash: string }[], payment => payment.hash);
    const known = collectKnownDisputeSecretsForHashlocks(hashlocks, state, counterparty);
    if (known.length === 0) return original;
    const decoded = original === '0x' ? { fillRatios: [], secrets: [] } : coder.decode([argumentType], original)[0];
    const secrets = [...new Set<string>([...decoded.secrets, ...known].map(secret => secret.toLowerCase()))];
    changed = true;
    return encodeDeltaTransformerArgs(Array.from(decoded.fillRatios, Number), secrets);
  });
  return changed ? wrapTransformerArgs(clauses) : existing;
};
