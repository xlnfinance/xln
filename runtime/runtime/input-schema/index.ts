import { validateRuntimeInputEnvelope } from '../../protocol/boundary-validation';
import type { RuntimeInput } from '../types';
import { validateRuntimeTx } from './runtime-tx';

/**
 * Decode the Runtime-owned part of an ingress batch before it reaches the
 * mempool. Child-machine inputs have their own owner decoders during Runtime
 * admission; Runtime transactions are fully decoded here and in WAL replay.
 */
export const decodeRuntimeInput = (
  value: unknown,
  code: string,
): RuntimeInput => {
  const input = validateRuntimeInputEnvelope(value, code);
  input.runtimeTxs.forEach((tx, index) =>
    validateRuntimeTx(tx, `${code}_RUNTIME_TX_${index}`));
  return input;
};
