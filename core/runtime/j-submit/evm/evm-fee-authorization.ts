import { ethers } from 'ethers';
import type { EvmFeeAuthorization, EvmFeeLimits } from '../../../types/jurisdiction-runtime';
import {
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireString,
} from '../../../protocol/boundary/boundary-primitives';
import type { RuntimeTx } from '../../types';
import { markLocalJSubmitRuntimeTx } from '../j-submit-state';

export const validateEvmFeeLimits = (value: unknown): EvmFeeLimits => {
  const limits = requireBoundaryRecord(value, 'EVM_FEE_LIMITS');
  requireExactBoundaryKeys(limits, ['maxFeePerGasWei', 'maxPriorityFeePerGasWei'], [], 'EVM_FEE_LIMITS_FIELDS');
  const read = (key: string): string => {
    const fee = requireString(limits[key], 'EVM_FEE_LIMIT');
    if (!/^(0|[1-9][0-9]{0,77})$/.test(fee) || BigInt(fee) >= 1n << 256n) throw new Error('EVM_FEE_LIMIT_INVALID');
    return fee;
  };
  const maxFeePerGasWei = read('maxFeePerGasWei');
  const maxPriorityFeePerGasWei = read('maxPriorityFeePerGasWei');
  if (BigInt(maxPriorityFeePerGasWei) > BigInt(maxFeePerGasWei)) throw new Error('EVM_FEE_LIMIT_PRIORITY');
  return { maxFeePerGasWei, maxPriorityFeePerGasWei };
};

export const validateEvmFeeAuthorization = (value: unknown): EvmFeeAuthorization => {
  const auth = requireBoundaryRecord(value, 'EVM_FEE_AUTHORIZATION');
  requireExactBoundaryKeys(
    auth,
    ['maxFeePerGasWei', 'maxPriorityFeePerGasWei', 'signature'],
    [],
    'EVM_FEE_AUTHORIZATION_FIELDS',
  );
  const limits = validateEvmFeeLimits({
    maxFeePerGasWei: auth['maxFeePerGasWei'],
    maxPriorityFeePerGasWei: auth['maxPriorityFeePerGasWei'],
  });
  const signature = requireString(auth['signature'], 'EVM_FEE_AUTHORIZATION_SIGNATURE');
  if (!/^0x[0-9a-f]{128}(?:1b|1c|00|01)$/.test(signature)) throw new Error('EVM_FEE_AUTHORIZATION_SIGNATURE');
  return { ...limits, signature };
};

/** Binds authorization to one local attempt and exact signed payer/chain/nonce/call.
 * Another Entity's fee request, an old attempt or a rejected sibling cannot raise it. */
export const evmFeeAuthorizationMessage = (
  jurisdictionName: string,
  attemptId: string,
  raw: string,
  limits: EvmFeeLimits,
): string =>
  ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['string', 'string', 'string', 'bytes32', 'uint256', 'uint256'],
      [
        'xln:evm-fee-authorization',
        jurisdictionName,
        attemptId,
        ethers.keccak256(raw),
        limits.maxFeePerGasWei,
        limits.maxPriorityFeePerGasWei,
      ],
    ),
  );

export const withinEvmFeeLimits = (
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  limits: EvmFeeLimits,
): boolean =>
  fees.maxFeePerGas <= BigInt(limits.maxFeePerGasWei) &&
  fees.maxPriorityFeePerGas <= BigInt(limits.maxPriorityFeePerGasWei);

export const signedEvmFeeLimits = (raw: string): EvmFeeLimits => {
  const tx = ethers.Transaction.from(raw);
  if (!tx.isSigned() || tx.type !== 2 || tx.maxFeePerGas === null || tx.maxPriorityFeePerGas === null)
    throw new Error('EVM_FEE_LIMIT_WIRE');
  return validateEvmFeeLimits({
    maxFeePerGasWei: String(tx.maxFeePerGas),
    maxPriorityFeePerGasWei: String(tx.maxPriorityFeePerGas),
  });
};

export const authorizedEvmFeeLimits = (
  jurisdiction: string,
  id: string,
  raw: string,
  auth?: EvmFeeAuthorization,
): EvmFeeLimits => {
  const signed = signedEvmFeeLimits(raw);
  if (!auth) return signed;
  const { signature, ...limits } = validateEvmFeeAuthorization(auth);
  const payer = ethers.Transaction.from(raw).from;
  if (
    ethers.verifyMessage(ethers.getBytes(evmFeeAuthorizationMessage(jurisdiction, id, raw, limits)), signature) !==
    payer
  )
    throw new Error('EVM_FEE_AUTHORIZATION_PAYER');
  if (
    BigInt(limits.maxFeePerGasWei) < BigInt(signed.maxFeePerGasWei) ||
    BigInt(limits.maxPriorityFeePerGasWei) < BigInt(signed.maxPriorityFeePerGasWei)
  )
    throw new Error('EVM_FEE_AUTHORIZATION_BELOW_WIRE');
  return limits;
};

/** Explicit payer action; caller enqueues and commits this input before retrying. */
export const authorizeEvmFeeLimits = async (
  signer: ethers.Signer,
  jurisdictionName: string,
  attemptId: string,
  rawTransaction: string,
  limits: EvmFeeLimits,
): Promise<Extract<RuntimeTx, { type: 'recordJPreparedTransaction' }>> => {
  const validated = validateEvmFeeLimits(limits);
  const signature = (
    await signer.signMessage(
      ethers.getBytes(evmFeeAuthorizationMessage(jurisdictionName, attemptId, rawTransaction, validated)),
    )
  ).toLowerCase();
  const feeAuthorization = { ...validated, signature };
  authorizedEvmFeeLimits(jurisdictionName, attemptId, rawTransaction, feeAuthorization);
  return markLocalJSubmitRuntimeTx({
    type: 'recordJPreparedTransaction',
    data: { jurisdictionName, attemptId, rawTransaction, feeAuthorization },
  });
};

/** One operator ceiling covers both EIP-1559 fields; default allows bounded bumps. */
export const initialEvmFeeLimits = (raw: string, ceilingWei?: string): EvmFeeLimits => {
  const wire = signedEvmFeeLimits(raw);
  const maxFee = BigInt(wire.maxFeePerGasWei);
  const configured = BigInt(ceilingWei ?? maxFee * 4n);
  const ceiling = String(configured < maxFee ? maxFee : configured);
  return validateEvmFeeLimits({ maxFeePerGasWei: ceiling, maxPriorityFeePerGasWei: ceiling });
};
