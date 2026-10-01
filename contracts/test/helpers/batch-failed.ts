import { expect } from 'chai';
import type { BaseContract, ContractTransactionReceipt, Interface } from 'ethers';

/** What a soft-failed batch reports in BatchFailed.reason: a custom error name, or the two built-in encodings. */
export type FailedReason = string | 'Panic' | 'Error' | 'none';

const BUILTIN_SELECTORS: Record<string, string> = {
  Panic: '0x4e487b71',
  Error: '0x08c379a0',
  none: '0x00000000',
};

const selectorOf = (iface: Interface, reason: FailedReason): string =>
  BUILTIN_SELECTORS[reason] ?? iface.getError(reason)!.selector;

type SignedBatch = { entityId: string; encodedBatch: string; hankoData: string; nonce: bigint };
type Depository = BaseContract & { connect: (runner: never) => any; entityNonces: (entityId: string) => Promise<bigint> };

/**
 * J5: a batch whose ops cannot apply returns normally. It emits BatchFailed(entityId, nonce, reason), never
 * HankoBatchProcessed, and spends its entity nonce. The caller asserts that no other state moved.
 */
export async function expectBatchFailed(
  depository: Depository,
  runner: unknown,
  signed: SignedBatch,
  reason: FailedReason,
): Promise<void> {
  const tx = await (depository.connect(runner as never) as any).processBatch(
    signed.entityId, signed.encodedBatch, signed.hankoData, signed.nonce,
  );
  const receipt = (await tx.wait()) as ContractTransactionReceipt;
  const events = receipt.logs.flatMap((log) => {
    const parsed = depository.interface.parseLog(log);
    return parsed ? [parsed] : [];
  });
  expect(events.some((e) => e.name === 'HankoBatchProcessed'), 'a failed batch must not emit HankoBatchProcessed').to.equal(false);
  const failed = events.filter((e) => e.name === 'BatchFailed');
  expect(failed.length, 'exactly one BatchFailed').to.equal(1);
  expect(failed[0]!.args.entityId).to.equal(signed.entityId);
  expect(failed[0]!.args.nonce).to.equal(signed.nonce);
  expect(failed[0]!.args.reason).to.equal(selectorOf(depository.interface, reason));
  expect(await depository.entityNonces(signed.entityId), 'a failed batch consumes its nonce').to.equal(signed.nonce);
}
