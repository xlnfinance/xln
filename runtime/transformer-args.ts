import { ethers } from 'ethers';
import type { AccountMachine } from './types';

const MAX_FILL_RATIO = 0xffff;

type BuildArgsOptions = {
  fillRatiosByOfferId?: Map<string, number>;
  leftSecrets?: string[];
  rightSecrets?: string[];
};

function clampFillRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= MAX_FILL_RATIO) return MAX_FILL_RATIO;
  return Math.floor(value);
}

function encodeDeltaTransformerArgs(fillRatios: number[], secrets: string[]): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const ratios = fillRatios.map(r => BigInt(clampFillRatio(r)));
  return abiCoder.encode(['uint32[]', 'bytes32[]'], [ratios, secrets]);
}

function wrapTransformerArgs(args: string): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return abiCoder.encode(['bytes[]'], [[args]]);
}

/**
 * Build per-side transformer arguments for DeltaTransformer.
 * Counterparty chooses fill ratios:
 * - Left-owned swap -> right args
 * - Right-owned swap -> left args
 */
export function buildDeltaTransformerArguments(
  accountMachine: AccountMachine,
  options: BuildArgsOptions = {}
): { leftArguments: string; rightArguments: string } {
  const hasLocks = accountMachine.locks?.size ? accountMachine.locks.size > 0 : false;
  const hasSwaps = accountMachine.swapOffers?.size ? accountMachine.swapOffers.size > 0 : false;
  if (!hasLocks && !hasSwaps) {
    return { leftArguments: '0x', rightArguments: '0x' };
  }

  const leftFillRatios: number[] = [];
  const rightFillRatios: number[] = [];
  const sortedSwaps = Array.from(accountMachine.swapOffers.entries())
    .sort((a, b) => a[0].localeCompare(b[0]));

  for (const [offerId, offer] of sortedSwaps) {
    const ratio = options.fillRatiosByOfferId?.get(offerId) ?? 0;
    if (offer.makerIsLeft) {
      rightFillRatios.push(ratio);
    } else {
      leftFillRatios.push(ratio);
    }
  }

  const leftSecrets = options.leftSecrets ?? [];
  const rightSecrets = options.rightSecrets ?? [];

  const leftArgs = encodeDeltaTransformerArgs(leftFillRatios, leftSecrets);
  const rightArgs = encodeDeltaTransformerArgs(rightFillRatios, rightSecrets);

  const hasLeftData = leftSecrets.length > 0 || leftFillRatios.some(r => r > 0);
  const hasRightData = rightSecrets.length > 0 || rightFillRatios.some(r => r > 0);

  return {
    leftArguments: hasLeftData ? wrapTransformerArgs(leftArgs) : '0x',
    rightArguments: hasRightData ? wrapTransformerArgs(rightArgs) : '0x',
  };
}
