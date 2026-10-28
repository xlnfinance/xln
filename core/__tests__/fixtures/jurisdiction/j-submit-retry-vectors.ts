// The canonical transition generates expectations at test time; no golden JSON is stored.
import { ethers } from 'ethers';
import { safeStringify } from '../../../protocol/serialization';
import { makeJSubmitDurabilityFixture, jurisdictionName } from './j-submit-durability-fixture';
import { applyRuntimeTx } from '../../../runtime/tx/tx-handlers';
import { initialEvmFeeLimits } from '../../../runtime/j-submit/evm/evm-fee-authorization';
import { collectDueJSubmitRuntimeTxs } from '../../../runtime/j-submit/j-submit-scheduler';
import { makeJSubmitResultRuntimeTx, registerPendingCommittedJOutbox } from '../../../runtime/j-submit/j-submit-state';

const vectors = [];
for (const signed of [false, true]) {
  const { env } = makeJSubmitDurabilityFixture();
  env.state.timestamp = 100;
  const first = collectDueJSubmitRuntimeTxs(env, env.state.timestamp)[0];
  if (!first) throw new Error('initial attempt missing');
  const jOutbox = await applyRuntimeTx(env, first, { isReplay: true });
  registerPendingCommittedJOutbox(env, jOutbox);
  const current = jOutbox[0]!.jTxs[0]!;
  if (current.type !== 'batch' || !current.data.runtimeSubmitAttempt) throw new Error('attempt missing');
  if (signed) {
    const raw = await new ethers.Wallet(`0x${'21'.repeat(32)}`).signTransaction({
      type: 2, chainId: 31337, nonce: 7, to: `0x${'22'.repeat(20)}`,
      gasLimit: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
    });
    current.data.runtimeSubmitAttempt.rawTransaction = raw;
    current.data.runtimeSubmitAttempt.evmFeeLimits = initialEvmFeeLimits(raw);
  }
  await applyRuntimeTx(env, makeJSubmitResultRuntimeTx(current, jurisdictionName, 'transientFailure'), { isReplay: true });
  if (!signed) registerPendingCommittedJOutbox(env, [{ jurisdictionName, jTxs: [current] }]);
  env.state.timestamp += 60001;
  const retry = collectDueJSubmitRuntimeTxs(env, env.state.timestamp)[0];
  if (!retry) throw new Error('retry missing');
  const next = (await applyRuntimeTx(env, retry, { isReplay: true }))[0]!.jTxs[0]!;
  if (next.type !== 'batch' || !next.data.runtimeSubmitAttempt) throw new Error('successor missing');
  const { feeBumpedAt, requestedGasBumpBps } = next.data.runtimeSubmitAttempt;
  vectors.push({ signed, metadata: { ...(feeBumpedAt === undefined ? {} : { feeBumpedAt }),
    ...(requestedGasBumpBps === undefined ? {} : { requestedGasBumpBps }) } });
}
console.log(safeStringify(vectors));
