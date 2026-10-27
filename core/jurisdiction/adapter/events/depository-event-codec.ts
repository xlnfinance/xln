import { Depository__factory } from '../../../../jurisdictions/typechain-types/index.ts';
import { ethers } from 'ethers';
import { PROOF_BODY_ABI } from '../../../protocol/dispute/proof-body';
import { materializeAbiValue, type JBatch } from '../../machine/batch';
import { validateProofBody } from '../../machine/batch-validation';
import type { DisputeFinalizationEvidence } from '../../../types/jurisdiction-events';

const coder = ethers.AbiCoder.defaultAbiCoder();
const proofParam = ethers.ParamType.from(PROOF_BODY_ABI);

/** The receipt authenticates these bytes; a mismatched or noncanonical body is never admitted. */
const decodeDisputeLogBody = (args: Record<string, unknown>, finalized: boolean): JBatch['disputeStarts'][number]['initialProofbody'] => {
  const body = args['proofbody'];
  const hash = args[finalized ? 'finalProofbodyHash' : 'proofbodyHash'];
  if (typeof body !== 'string' || !ethers.isHexString(body) || ethers.keccak256(body) !== hash) {
    throw new Error('J_DISPUTE_EVENT_PROOFBODY_HASH_MISMATCH');
  }
  const [decoded] = coder.decode([proofParam], body);
  if (coder.encode([proofParam], [decoded]) !== body.toLowerCase()) {
    throw new Error('J_DISPUTE_EVENT_PROOFBODY_NONCANONICAL');
  }
  return validateProofBody(materializeAbiValue(proofParam, decoded, 'dispute.proofbody'), 'J_DISPUTE_EVENT_PROOFBODY') as JBatch['disputeStarts'][number]['initialProofbody'];
};

const hex = (value: unknown): string => {
  if (typeof value !== 'string' || !ethers.isHexString(value)) throw new Error('J_DISPUTE_EVENT_HEX_INVALID');
  return value.toLowerCase();
};
const decimal = (value: unknown): string => {
  if (typeof value !== 'bigint' || value < 0n) throw new Error('J_DISPUTE_EVENT_UINT_INVALID');
  return value.toString();
};
const boolean = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('J_DISPUTE_EVENT_BOOL_INVALID');
  return value;
};

export const validateDisputeFinalizationLog = (args: Record<string, unknown>) => {
  const data = args['finalization'];
  if (!data || typeof data !== 'object') throw new Error('J_DISPUTE_EVENT_FINALIZATION_MISSING');
  const initialProofbodyHash = hex(Reflect.get(data, 'initialProofbodyHash'));
  const finalNonce = decimal(Reflect.get(data, 'finalNonce'));
  const proposerIsLeft = boolean(Reflect.get(data, 'proposerIsLeft'));
  const startedByLeft = boolean(Reflect.get(data, 'startedByLeft'));
  const starterArgumentsHash = hex(Reflect.get(data, 'starterArgumentsHash'));
  const otherArguments = hex(Reflect.get(data, 'otherArguments'));
  const sig = hex(Reflect.get(data, 'sig'));
  const hash = ethers.keccak256(coder.encode(
    ['bytes32', 'uint256', 'bool', 'bool', 'bytes32', 'bytes32', 'bytes32'],
    [initialProofbodyHash, finalNonce, proposerIsLeft, startedByLeft,
      starterArgumentsHash, ethers.keccak256(otherArguments), ethers.keccak256(sig)],
  ));
  if (hash !== args['finalizationEvidenceHash']) throw new Error('J_DISPUTE_EVENT_FINALIZATION_HASH_MISMATCH');
  return { initialProofbodyHash, finalNonce, proposerIsLeft, startedByLeft, starterArgumentsHash, otherArguments, sig };
};

export const decodeDisputeFinalizationLog = (args: Record<string, unknown>): DisputeFinalizationEvidence => {
  const { initialProofbodyHash, finalNonce, proposerIsLeft, startedByLeft, starterArgumentsHash, otherArguments, sig } = validateDisputeFinalizationLog(args);
  const starterArguments = hex(args['starterArguments'] ?? '0x');
  if (ethers.keccak256(starterArguments) !== starterArgumentsHash) throw new Error('J_DISPUTE_EVENT_STARTER_ARGUMENTS_MISSING');
  return {
    sender: hex(args['sender']), counterentity: hex(args['counterentity']),
    initialNonce: decimal(args['initialNonce']), finalNonce, initialProofbodyHash,
    finalProofbodyHash: hex(args['finalProofbodyHash']), proposerIsLeft, startedByLeft, sig,
    leftArguments: startedByLeft ? starterArguments : otherArguments,
    rightArguments: startedByLeft ? otherArguments : starterArguments,
  };
};

type DepositoryLog = {
  topics: readonly string[];
  data: string;
};

// Parse against the generated contract ABI, not a hand-maintained canonical
// subset. Depository telemetry is intentionally non-consensus, but it must be
// recognized before the watcher can safely filter it from canonical J-events.
const depositoryInterface = Depository__factory.createInterface();

export const parseKnownDepositoryLog = (log: DepositoryLog): ethers.LogDescription | null =>
  depositoryInterface.parseLog({ topics: [...log.topics], data: log.data });

export const extractCanonicalDepositoryEventArgs = (
  parsed: ethers.LogDescription,
): Record<string, unknown> => {
  const args: Record<string, unknown> = {};
  for (let index = 0; index < parsed.fragment.inputs.length; index++) {
    const input = parsed.fragment.inputs[index];
    if (!input) continue;
    const value = parsed.args[index];
    args[input.name || String(index)] = value;
    if (input.name) args[input.name] = value;
  }

  // Solidity calls this field `nonce`, while the runtime event schema calls it
  // `initialNonce` to distinguish it from the post-finalization Account nonce.
  if (parsed.name === 'DisputeFinalized') {
    if (args['nonce'] === undefined) throw new Error('J_DISPUTE_FINALIZED_NONCE_MISSING');
    args['initialNonce'] = args['nonce'];
  }
  if (['DisputeStarted', 'CounterDisputeRegistered', 'DisputeFinalized'].includes(parsed.name)) {
    const field = parsed.name === 'DisputeStarted' ? 'initialProofbody'
      : parsed.name === 'CounterDisputeRegistered' ? 'counterProofbody' : 'finalProofbody';
    if (args['proofbody'] === '0x' && parsed.name !== 'DisputeStarted') return args;
    const body = decodeDisputeLogBody(args, parsed.name === 'DisputeFinalized');
    if (parsed.name === 'DisputeStarted' && (body.watchSeed !== args['watchSeed']
      || BigInt(body.leftResponseSeconds) !== args['leftResponseSeconds']
      || BigInt(body.rightResponseSeconds) !== args['rightResponseSeconds'])) {
      throw new Error('J_DISPUTE_EVENT_START_BINDING_MISMATCH');
    }
    args[field] = body;
  }
  return args;
};
