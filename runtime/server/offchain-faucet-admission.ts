import type { AccountMachine } from '../types';

export type OffchainFaucetAccountState = {
  exists: boolean;
  currentHeight: number;
  pendingFrameHeight: number | null;
  mempool: number;
  settledCapacitySnapshot: boolean;
};

export const hasSettledOffchainFaucetCapacitySnapshot = (
  account: AccountMachine | null | undefined,
): boolean =>
  Boolean(account?.currentFrame) &&
  Number(account?.currentHeight ?? 0) > 0 &&
  !account?.pendingFrame &&
  Number(account?.mempool?.length ?? 0) === 0;

export const describeOffchainFaucetAccountState = (
  account: AccountMachine | null | undefined,
): OffchainFaucetAccountState => ({
  exists: !!account,
  currentHeight: Number(account?.currentHeight ?? 0),
  pendingFrameHeight: account?.pendingFrame ? Number(account.pendingFrame.height ?? 0) : null,
  mempool: Number(account?.mempool?.length ?? 0),
  settledCapacitySnapshot: hasSettledOffchainFaucetCapacitySnapshot(account),
});

export const shouldRejectOffchainFaucetForSettledCapacity = (input: {
  account: AccountMachine | null | undefined;
  senderOutCapacity: bigint;
  amount: bigint;
}): boolean =>
  hasSettledOffchainFaucetCapacitySnapshot(input.account) &&
  input.senderOutCapacity < input.amount;
