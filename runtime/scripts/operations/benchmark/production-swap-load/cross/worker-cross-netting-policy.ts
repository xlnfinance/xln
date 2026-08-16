/** Commit manual rebalance mode on experiment-controlled Accounts. */

import { readLoadAccount, sendObserved, type ConnectedRuntime } from '../worker-runtime';

export type CrossNettingPolicyIdentity = Readonly<{ entityId: string; signerId: string }>;

export type CrossNettingManualPolicyAccount = Readonly<{
  owner: CrossNettingPolicyIdentity;
  counterparty: Readonly<{ entityId: string }>;
}>;

export type CrossNettingManualPolicyOptions = Readonly<{
  runtime: ConnectedRuntime;
  accounts: readonly CrossNettingManualPolicyAccount[];
  tokenId: number;
  manualLimit: bigint;
  maxAcceptableFee: bigint;
  commandId: string;
}>;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export const commitCrossNettingManualMode = async (
  options: CrossNettingManualPolicyOptions,
): Promise<void> => {
  if (!Number.isSafeInteger(options.tokenId) || options.tokenId < 1) {
    throw new Error(`CROSS_NETTING_MANUAL_POLICY_TOKEN_INVALID:${options.tokenId}`);
  }
  if (options.manualLimit < 0n || options.maxAcceptableFee < 0n) {
    throw new Error('CROSS_NETTING_MANUAL_POLICY_AMOUNT_INVALID');
  }
  if (options.accounts.length < 1) throw new Error('CROSS_NETTING_MANUAL_POLICY_ACCOUNTS_EMPTY');
  if (!options.commandId.trim()) throw new Error('CROSS_NETTING_MANUAL_POLICY_COMMAND_ID_INVALID');
  const policyTx = (counterparty: Readonly<{ entityId: string }>) => ({
    type: 'setRebalancePolicy' as const,
    data: {
      counterpartyEntityId: counterparty.entityId,
      tokenId: options.tokenId,
      r2cRequestSoftLimit: options.manualLimit,
      hardLimit: options.manualLimit,
      maxAcceptableFee: options.maxAcceptableFee,
    },
  });
  await sendObserved(options.runtime, options.commandId, {
    runtimeTxs: [],
    entityInputs: options.accounts.map(account => ({
      entityId: account.owner.entityId,
      signerId: account.owner.signerId,
      entityTxs: [policyTx(account.counterparty)],
    })),
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const accounts = await Promise.all(options.accounts.map(account =>
      readLoadAccount(options.runtime, account.owner.entityId, account.counterparty.entityId)
    ));
    const committed = accounts.every(account => {
      const policy = account?.shadow.rebalance.policy.get(options.tokenId);
      return policy?.r2cRequestSoftLimit === options.manualLimit &&
        policy.hardLimit === options.manualLimit &&
        policy.maxAcceptableFee === options.maxAcceptableFee;
    });
    if (committed) return;
    await sleep(100);
  }
  throw new Error('CROSS_NETTING_MANUAL_POLICY_NOT_COMMITTED');
};
