import type { RuntimeReplica } from '../runtime/types';
import type { JTx } from '../types/jurisdiction-runtime';
import type { JAdapter } from '../jurisdiction/adapter/types';
import type { JBatch } from '../jurisdiction/machine/batch';
import { batchOpCount } from '../jurisdiction/machine/batch';
import { getSignerPrivateKey } from '../account/crypto';
import { prepareSignedBatch } from '../hanko/batch';

export async function submitSignedScenarioBatch(
  env: RuntimeReplica,
  jadapter: JAdapter,
  entityId: string,
  signerId: string,
  batch: JBatch,
  errorPrefix: string,
): Promise<void> {
  const signerPrivateKey = getSignerPrivateKey(env, signerId);

  const currentNonce = await jadapter.getEntityNonce(entityId);
  const { encodedBatch, hankoData, nextNonce, batchHash } = prepareSignedBatch(
    batch,
    entityId,
    signerPrivateKey,
    BigInt(jadapter.chainId),
    jadapter.addresses.depository,
    currentNonce,
  );

  const jTx: JTx = {
    type: 'batch',
    entityId,
    data: {
      batch,
      batchSize: batchOpCount(batch),
      signerId,
      encodedBatch,
      entityNonce: Number(nextNonce),
      hankoSignature: hankoData,
      batchHash,
    },
    timestamp: env.state.timestamp,
  };
  const result = await jadapter.submitTx(jTx, {
    env,
    signerId,
    signerPrivateKey,
    timestamp: env.state.timestamp,
  });
  if (!result.success) {
    throw new Error(result.error || `${errorPrefix}: signed batch failed`);
  }
}
