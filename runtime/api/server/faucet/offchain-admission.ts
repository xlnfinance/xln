import type { AccountReplica } from '../../../types/account';

export type OffchainFaucetAccountState = {
  exists: boolean;
  currentHeight: number;
  pendingFrameHeight: number | null;
  mempool: number;
  settledCapacitySnapshot: boolean;
};

const hasSettledOffchainFaucetCapacitySnapshot = (
  account: AccountReplica | null | undefined,
): boolean =>
  Boolean(account?.currentFrame) &&
  Number(account?.currentHeight ?? 0) > 0 &&
  !account?.pendingFrame &&
  Number(account?.mempool?.length ?? 0) === 0;

export const describeOffchainFaucetAccountState = (
  account: AccountReplica | null | undefined,
): OffchainFaucetAccountState => ({
  exists: !!account,
  currentHeight: Number(account?.currentHeight ?? 0),
  pendingFrameHeight: account?.pendingFrame ? Number(account.pendingFrame.height ?? 0) : null,
  mempool: Number(account?.mempool?.length ?? 0),
  settledCapacitySnapshot: hasSettledOffchainFaucetCapacitySnapshot(account),
});

export const shouldRejectOffchainFaucetForSettledCapacity = (input: {
  account: AccountReplica | null | undefined;
  senderOutCapacity: bigint;
  amount: bigint;
}): boolean =>
  hasSettledOffchainFaucetCapacitySnapshot(input.account) &&
  input.senderOutCapacity < input.amount;
