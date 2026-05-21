import type { AccountFrame } from './types';
import { assertAccountFrameDeltaIntegrity } from './account-frame';
import { safeStringify } from './serialization-utils';

export const MAX_ACCOUNT_FRAME_TXS = 100;
export const MAX_FRAME_TIMESTAMP_DRIFT_MS = 300_000;
export const MAX_FRAME_SIZE_BYTES = 1_048_576;

export function validateAccountFrame(
  frame: AccountFrame,
  currentTimestamp?: number,
  previousFrameTimestamp?: number,
): boolean {
  if (frame.height < 0) return false;
  if (typeof frame.jHeight !== 'number' || frame.jHeight < 0) return false;
  if (frame.accountTxs.length > MAX_ACCOUNT_FRAME_TXS) return false;
  try {
    assertAccountFrameDeltaIntegrity(frame, `AccountFrame#${frame.height}`);
  } catch (error) {
    console.warn(`❌ Invalid account frame delta integrity: ${(error as Error).message}`);
    return false;
  }

  if (currentTimestamp !== undefined) {
    if (Math.abs(frame.timestamp - currentTimestamp) > MAX_FRAME_TIMESTAMP_DRIFT_MS) {
      console.log(`❌ Frame timestamp drift too large: ${frame.timestamp} vs ${currentTimestamp}`);
      return false;
    }

    if (previousFrameTimestamp !== undefined && frame.timestamp < previousFrameTimestamp) {
      console.log(
        `❌ Frame timestamp went backwards: ${frame.timestamp} < ${previousFrameTimestamp} (delta: ${previousFrameTimestamp - frame.timestamp}ms)`,
      );
      return false;
    }
  }

  return true;
}

export async function createFrameHash(frame: AccountFrame): Promise<string> {
  assertAccountFrameDeltaIntegrity(frame, `AccountFrame#${frame.height}`);
  const { ethers } = await import('ethers');

  const frameData = {
    height: frame.height,
    timestamp: frame.timestamp,
    jHeight: frame.jHeight,
    prevFrameHash: frame.prevFrameHash,
    accountTxs: frame.accountTxs.map(tx => ({
      type: tx.type,
      data: tx.data,
    })),
    deltas: frame.deltas.map(delta => ({
      tokenId: delta.tokenId,
      collateral: delta.collateral.toString(),
      ondelta: delta.ondelta.toString(),
      offdelta: delta.offdelta.toString(),
      leftCreditLimit: delta.leftCreditLimit.toString(),
      rightCreditLimit: delta.rightCreditLimit.toString(),
      leftAllowance: delta.leftAllowance.toString(),
      rightAllowance: delta.rightAllowance.toString(),
      leftHold: (delta.leftHold || 0n).toString(),
      rightHold: (delta.rightHold || 0n).toString(),
    })),
  };

  const encoded = safeStringify(frameData);
  return ethers.keccak256(ethers.toUtf8Bytes(encoded));
}

export async function computeFrameHash(frame: AccountFrame): Promise<string> {
  return createFrameHash(frame);
}
