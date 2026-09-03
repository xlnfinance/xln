import {
  clearSignerKeys,
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../../account/crypto';
import { PersistentEntityAccountMap } from '../../entity/state/persistent-account-map';
import { computeEntityAccountValueHash } from '../../entity/consensus/state-root';
import { applyEntityInput } from '../../entity/consensus';
import { createEntityFrameHashFromStateRoot } from '../../entity/consensus/frame';
import { buildEntityHashesToSign } from '../../entity/consensus/input/hanko-witness';
import {
  deriveEntityEncryptionPublicKey,
  provisionEntityEncryptionKey,
} from '../../entity/auth/crypto';
import { generateLazyEntityId } from '../../entity/factory';
import type { EntityFrame, EntityReplica, EntityState } from '../../entity/types';
import { createEmptyEnv } from '../../runtime';
import { hexlify } from 'ethers';

const defaultSignerLabels = ['1', '2', '3'] as const;

export const createEntityProposalFixture = (
  seed: string,
  threshold = 2n,
  signerLabels: readonly string[] = defaultSignerLabels,
) => {
  const validators = signerLabels.map(label =>
    deriveSignerAddressSync(seed, label).toLowerCase());
  const entityId = generateLazyEntityId(validators, threshold).toLowerCase();
  const entityEncryptionPrivateKey = hexlify(deriveSignerKeySync(seed, 'entity-encryption'));
  const entityEncryptionPublicKey = deriveEntityEncryptionPublicKey(
    entityEncryptionPrivateKey,
    entityId,
  );

  const createState = (): EntityState => ({
    entityId,
    entityEncryptionPublicKey,
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
    accounts: PersistentEntityAccountMap.empty(entityId, computeEntityAccountValueHash),
    lastFinalizedJHeight: 0,
    profile: { name: '', isHub: false, avatar: '', bio: '', website: '' },
    paybook: { entries: new Map(), feesEarned: 0n },
  });

  const createValidator = (label: string) => {
    const env = createEmptyEnv(`${seed}:${label}`);
    clearSignerKeys(env);
    const signerIndex = signerLabels.indexOf(label);
    if (signerIndex < 0) throw new Error(`TEST_ENTITY_SIGNER_LABEL_UNKNOWN:${label}`);
    const signerId = validators[signerIndex]!;
    registerSignerKey(env, signerId, deriveSignerKeySync(seed, label));
    env.state.timestamp = 1_000;
    env.quietRuntimeLogs = true;
    provisionEntityEncryptionKey(env, entityId, entityEncryptionPrivateKey);
    const replica: EntityReplica = {
      entityId,
      signerId,
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
    // Keep the mutation wire-canonical so proposal pre-authentication reaches
    // the intended signature/command checks instead of failing shape decode.
    command.data.signature = `0x${'55'.repeat(64)}01`;
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
      frame.entityContext,
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
