import { safeStringify } from '../../../../../core/protocol/serialization';

export const runProgressMarker = 'USDC_EXECUTION_PROGRESS_RUN:';
export const slotProgressMarker = 'USDC_EXECUTION_PROGRESS_SLOT:';

export type ProgressSlot = Readonly<{
  step: string;
  chainId: number;
  nonce: number;
  hash: string | null;
  status:
    | 'attempted'
    | 'submitted'
    | 'known'
    | 'confirmed'
    | 'reverted'
    | 'conflict'
    | 'pending'
    | 'unobserved'
    | 'unavailable';
}>;

export const logProgressSlot = (runId: string, { step, chainId, nonce, hash, status }: ProgressSlot): void =>
  console.log(slotProgressMarker + safeStringify({ runId, step, chainId, nonce, hash, status }));
