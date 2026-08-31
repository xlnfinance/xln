import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import { accountInputAck, accountInputProposal } from '../../../../account/consensus/flush';
import { computeEntityAccountValueHash, projectEntityAccountLeaf } from '../../../../entity/consensus/state-root';
import { createEntityFrameCandidateState } from '../../../../entity/state-clone';
import { putEntityAccountCandidate } from '../../../../entity/state/persistent-account-map';
import { resolveInboundAccount } from '../../../../entity/tx/handlers/account/inbound-account';
import { deriveMeshChildSeed } from '../../../../orchestrator/mesh/mesh-seeds';
import { safeStringify } from '../../../../protocol/serialization';
import {
  closeInfraDb,
  closeRuntimeDb,
  restoreEnvFromRecoveryBundles,
} from '../../../../runtime';
import type { RuntimeRecoveryBundleV1 } from '../../../../storage/recovery/bundle/types';
import type { AccountInput } from '../../../../types/account';
import type { EntityInput } from '../../../../entity/types';
import { readHltHubRecording } from './recording';

const CODE_MAP = {
  dispatch: 'core/entity/tx/apply.ts:224-233',
  prepare: 'core/entity/tx/handlers/account/index.ts:134-225',
  participantValidation: 'core/entity/tx/handlers/account/inbound-account.ts:51-68',
  unknownGenesisValidation: 'core/entity/tx/handlers/account/inbound-account.ts:103-136',
  domainValidation: 'core/entity/tx/handlers/account/inbound-account.ts:70-101',
  watchSeedValidation: 'core/entity/tx/handlers/account/inbound-account.ts:227-243',
  h0Construction: 'core/entity/tx/handlers/account/inbound-account.ts:138-207',
  recordCreateBeforePeer: 'core/entity/tx/handlers/account/index.ts:188-200',
  applyPeerFrame: 'core/entity/tx/handlers/account/index.ts:247-271',
  publishAfterH1Commit: 'core/entity/tx/handlers/account/committed-input.ts:515-523',
  seedWire: 'core/rscore/authority-wave.ts:335-383; core/rscore/shadow-wire.ts:548-585',
} as const;

type InboundGenesisCandidate = Readonly<{
  runtimeHeight: number;
  inputIndex: number;
  txIndex: number;
  entityInput: EntityInput;
  input: AccountInput;
}>;

const normalizeId = (value: string): string => value.trim().toLowerCase();

const findFirstInboundGenesis = (
  frames: readonly NonNullable<RuntimeRecoveryBundleV1['frames']>[number][],
  baseAccounts: ReadonlyMap<string, ReadonlySet<string>>,
): InboundGenesisCandidate => {
  for (const frame of frames) {
    for (const [inputIndex, entityInput] of frame.runtimeInput.entityInputs.entries()) {
      const known = baseAccounts.get(normalizeId(entityInput.entityId));
      if (!known) continue;
      for (const [txIndex, tx] of (entityInput.entityTxs ?? []).entries()) {
        if (tx.type !== 'accountInput') continue;
        const input = tx.data;
        const proposal = accountInputProposal(input);
        if (!known.has(normalizeId(input.fromEntityId)) && proposal?.frame.height === 1) {
          return { runtimeHeight: frame.height, inputIndex, txIndex, entityInput, input };
        }
      }
    }
  }
  throw new Error('HLT_AUTHORITY_INBOUND_GENESIS_NOT_FOUND');
};

const writeAtomicReport = (path: string, report: unknown): void => {
  const temporary = `${path}.tmp-${process.pid}`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(descriptor, `${safeStringify(report, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
};

export const writeAuthorityReplayPreflight = async (options: Readonly<{
  recordingPath: string;
  outputPath: string;
  seedFile?: string;
}>): Promise<void> => {
  const artifact = readHltHubRecording(resolve(options.recordingPath));
  const snapshot = artifact.recording.bundles.find(bundle => bundle.kind === 'snapshot');
  const tail = artifact.recording.bundles.find(bundle => bundle.kind === 'journal_tail');
  if (!snapshot || !tail?.frames) throw new Error('HLT_AUTHORITY_PREFLIGHT_BUNDLES_MISSING');
  const seedFile = resolve(options.seedFile ?? `${artifact.source.workDir}/secrets/mesh-root.seed`);
  const meshRootSeed = readFileSync(seedFile, 'utf8').trim();
  if (!meshRootSeed) throw new Error('HLT_AUTHORITY_PREFLIGHT_SEED_MISSING');
  const runtimeSeed = deriveMeshChildSeed(meshRootSeed, 'runtime:h1');
  const env = await restoreEnvFromRecoveryBundles([snapshot], {
    runtimeSeed,
    runtimeId: artifact.recording.runtimeId,
    targetHeight: artifact.recording.baseHeight,
    readOnly: true,
  });
  try {
    const replicas = [...env.state.eReplicas.values()];
    const baseAccounts = new Map(replicas.map(replica => [
      normalizeId(replica.entityId),
      new Set([...replica.state.accounts.keys()].map(normalizeId)),
    ]));
    const candidate = findFirstInboundGenesis(tail.frames, baseAccounts);
    const owner = normalizeId(candidate.entityInput.entityId);
    const matchingReplicas = replicas.filter(replica =>
      normalizeId(replica.entityId) === owner &&
      normalizeId(replica.signerId) === normalizeId(candidate.entityInput.signerId));
    const replica = matchingReplicas[0];
    if (matchingReplicas.length !== 1 || !replica) {
      throw new Error(`HLT_AUTHORITY_PREFLIGHT_OWNER_NOT_UNIQUE:${owner}`);
    }
    const state = createEntityFrameCandidateState(replica.state);
    const parentAccountsRoot = state.accounts.rootHash();
    const proposal = accountInputProposal(candidate.input);
    const ack = accountInputAck(candidate.input);
    const resolution = resolveInboundAccount(
      state,
      candidate.input,
      ack !== undefined,
      proposal !== undefined,
    );
    const account = resolution.account;
    const accountId = normalizeId(resolution.counterpartyId);
    const entityLeafDigest = computeEntityAccountValueHash(account);
    putEntityAccountCandidate(state.accounts, accountId, account);
    const report = {
      schema: 'xln-rscore-authority-replay-preflight-v1',
      recordingPath: resolve(options.recordingPath),
      baseRuntimeHeight: artifact.recording.baseHeight,
      firstInboundGenesis: {
        runtimeHeight: candidate.runtimeHeight,
        inputIndex: candidate.inputIndex,
        txIndex: candidate.txIndex,
        ownerEntityId: owner,
        signerId: normalizeId(candidate.entityInput.signerId),
        accountId,
        kind: candidate.input.kind,
        fromEntityId: candidate.input.fromEntityId,
        toEntityId: candidate.input.toEntityId,
        proposalHeight: proposal?.frame.height ?? null,
        proposalStateHash: proposal?.frame.stateHash ?? null,
        domain: candidate.input.domain,
        watchSeed: candidate.input.watchSeed,
        disputeConfig: candidate.input.disputeConfig,
      },
      parent: {
        entityHeight: replica.state.height,
        accountCount: replica.state.accounts.size,
        accountsRoot: parentAccountsRoot,
        targetExists: replica.state.accounts.has(accountId),
        rustBootstrapSeedIncluded: replica.state.accounts.has(accountId),
      },
      expectedH0BeforePeerFrame: {
        createdAccount: resolution.createdAccount,
        currentHeight: account.currentHeight,
        currentFrameHeight: account.currentFrame.height,
        currentFrameStateHash: account.currentFrame.stateHash,
        mempoolCount: account.mempool.length,
        pendingFrame: account.pendingFrame ?? null,
        accountStateRoot: account.currentFrame.accountStateRoot,
        entityLeafDigest,
        accountsRootWithH0: state.accounts.rootHash(),
        entityLeafProjection: projectEntityAccountLeaf(account),
      },
      requiredValidation: {
        targetIsOwner: normalizeId(candidate.input.toEntityId) === owner,
        senderIsCounterparty: normalizeId(candidate.input.fromEntityId) === accountId,
        senderIsNotOwner: accountId !== owner,
        proposalHeightIsGenesis: proposal?.frame.height === 1,
        ackPresent: ack !== undefined,
        domain: candidate.input.domain,
        watchSeed: candidate.input.watchSeed,
        disputeConfig: candidate.input.disputeConfig,
      },
      codeMap: CODE_MAP,
    };
    writeAtomicReport(resolve(options.outputPath), report);
  } finally {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
  }
};
