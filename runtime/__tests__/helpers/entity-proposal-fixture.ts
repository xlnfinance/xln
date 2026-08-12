import {
  clearSignerKeys,
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../../account/crypto';
import { applyEntityInput } from '../../entity/consensus';
import { createEntityFrameHashFromStateRoot } from '../../entity/consensus/frame';
import { buildEntityHashesToSign } from '../../entity/consensus/input/hanko-witness';
import { deriveLocalEntityCryptoKeys } from '../../entity/auth/crypto';
import { generateLazyEntityId } from '../../entity/factory';
import type { EntityFrame, EntityReplica, EntityState } from '../../entity/types';
import { createEmptyEnv } from '../../runtime';

const signerLabels = ['1', '2', '3'] as const;
type SignerLabel = typeof signerLabels[number];

export const createEntityProposalFixture = (
  seed: string,
  threshold = 2n,
) => {
  const validators = signerLabels.map(label =>
    deriveSignerAddressSync(seed, label).toLowerCase());
  const entityId = generateLazyEntityId(validators, threshold).toLowerCase();

  const createState = (): EntityState => ({
    entityId,
    height: 0,
    timestamp: 0,
    nonces: new Map(),
    proposals: new Map(),
    config: {
      mode: 'proposer-based',
      threshold,
      validators,
      shares: Object.fromEntries(validators.map(validator => [validator, 1n])),
    },
    reserves: new Map(),
    accounts: new Map(),
    lastFinalizedJHeight: 0,
    jBlockChain: [],
    profile: { name: '', isHub: false, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    lockBook: new Map(),
  });

  const createValidator = (label: SignerLabel) => {
    const env = createEmptyEnv(`${seed}:${label}`);
    clearSignerKeys(env);
    const signerId = validators[signerLabels.indexOf(label)]!;
    registerSignerKey(env, signerId, deriveSignerKeySync(seed, label));
    env.state.timestamp = 1_000;
    env.quietRuntimeLogs = true;
    const keys = deriveLocalEntityCryptoKeys(env, entityId, signerId);
    const replica: EntityReplica = {
      entityId,
      signerId,
      entityEncPubKey: keys.publicKey,
      state: createState(),
      mempool: [],
      isProposer: label === '1',
    };
    return { env, replica, signerId };
  };

  const buildHonestProposal = async (): Promise<{
    frame: EntityFrame;
    proposer: ReturnType<typeof createValidator>;
    proposerReplica: EntityReplica;
  }> => {
    const proposer = createValidator('1');
    const result = await applyEntityInput(proposer.env, proposer.replica, {
      entityId,
      signerId: proposer.signerId,
      entityTxs: [{
        type: 'chat',
        data: { from: proposer.signerId, message: 'bound proposal' },
      }],
    });
    const frame = result.workingReplica.proposal;
    if (!frame || frame.txs[0]?.type !== 'entityCommand') {
      throw new Error('TEST_ENTITY_PROPOSAL_MISSING');
    }
    return {
      frame: structuredClone(frame),
      proposer,
      proposerReplica: result.workingReplica,
    };
  };

  const mutateNestedCommand = (frame: EntityFrame): void => {
    const command = frame.txs[0];
    if (command?.type !== 'entityCommand') {
      throw new Error('TEST_ENTITY_COMMAND_MISSING');
    }
    command.data.signature = `0x${'00'.repeat(65)}`;
  };

  const bindMutatedFrame = (
    frame: EntityFrame,
    proposer: ReturnType<typeof createValidator>,
    useCapturedSignature: boolean,
  ): void => {
    const capturedSignature = frame.collectedSigs?.get(proposer.signerId)?.[0];
    frame.hash = createEntityFrameHashFromStateRoot(
      frame.parentFrameHash,
      frame.height,
      frame.timestamp,
      frame.txs,
      frame.events,
      entityId,
      frame.stateRoot,
      frame.authorityRoot,
      frame.jPrefixCertificate,
    );
    frame.hashesToSign = buildEntityHashesToSign(entityId, frame.height, frame.hash);
    frame.collectedSigs = new Map([[
      proposer.signerId,
      [useCapturedSignature
        ? capturedSignature!
        : signAccountFrame(proposer.env, proposer.signerId, frame.hash)],
    ]]);
  };

  return {
    bindMutatedFrame,
    buildHonestProposal,
    createState,
    createValidator,
    entityId,
    mutateNestedCommand,
    validators,
  };
};
