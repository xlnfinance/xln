import type { Env, JTx } from '../types';
import type { JAdapter } from '../jadapter/types';
import type { JBatch } from '../jurisdiction/batch';
import { getBatchSize } from '../jurisdiction/batch';
import { getCachedSignerPrivateKey } from '../account-crypto';
import { prepareSignedBatch } from '../hanko/batch';

export async function submitSignedScenarioBatch(
  env: Env,
  jadapter: JAdapter,
  entityId: string,
  signerId: string,
  batch: JBatch,
  errorPrefix: string,
): Promise<void> {
  const signerPrivateKey = getCachedSignerPrivateKey(signerId);
  if (!signerPrivateKey) {
    throw new Error(`${errorPrefix}: missing signer private key for ${signerId}`);
  }

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
      batchSize: getBatchSize(batch),
      signerId,
      encodedBatch,
      entityNonce: Number(nextNonce),
      hankoSignature: hankoData,
      batchHash,
    },
    timestamp: env.timestamp,
  };
  const result = await jadapter.submitTx(jTx, {
    env,
    signerId,
    signerPrivateKey,
    timestamp: env.timestamp,
  });
  if (!result.success) {
    throw new Error(result.error || `${errorPrefix}: signed batch failed`);
  }
}
