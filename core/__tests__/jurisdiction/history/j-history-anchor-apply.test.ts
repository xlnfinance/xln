import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import type { EntityRuntimeContext } from '../../../entity/runtime-context';
import type { EntityState } from '../../../entity/types';
import { registerSignerKey } from '../../../account/crypto';
import {
  applyJAnchor,
  applyJHistoryAnchor,
  buildJAnchorTx,
  type JHistoryAnchorTxData,
  type JHistoryAnchorValues,
} from '../../../entity/tx/j-anchor/j-anchor-finality';
import { validateEntityTx } from '../../../entity/tx-validation';
import {
  buildEntityTransactionProposalAction,
  isCollectiveEntityActionTx,
  isEntityProtocolTx,
  isIndividualEntityCommandTx,
} from '../../../entity/auth/authorization';
import { assertEntityCommandTxs } from '../../../entity/command/command-codec';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { getJEventJurisdictionRef } from '../../../jurisdiction/machine/event-observation';
import { FailureDispositionError } from '../../../protocol/errors/failure-taxonomy';
import { buildNonceAnchorRoot, nonceViewFromStorage } from '../../../jurisdiction/adapter/rpc/state-anchor/rpc-nonce-anchor';
import {
  buildDebtAnchorRoot,
  buildEntityProvenValuesFromFold,
  buildProvenValuesRoot,
  debtViewFromLedgers,
} from '../../../jurisdiction/adapter/rpc/state-anchor/rpc-proven-values-root';
import { buildReserveAnchorRoot } from '../../../jurisdiction/adapter/rpc/state-anchor/rpc-reserve-anchor';
import {
  EMPTY_CERTIFIED_BOARD_ROOT,
  getCertifiedBoardNodeStore,
  getCertifiedBoardStackKey,
  lookupCertifiedBoardRecord,
  putCertifiedBoardRecord,
} from '../../../jurisdiction/machine/board-registry';
import { buildJHistoryAnchorClaimDigest, buildJHistoryAnchorRoot } from '../../../jurisdiction/machine/history-consensus';
import { validateJHistoryAnchorClaim } from '../../../jurisdiction/machine/j-event-range-validation';
import { buildCarriedProvenValues } from '../../../jurisdiction/machine/state-anchor/proven-values-root';
import type { CertifiedBoardRecord } from '../../../types/entity-board-registry';

const proposer = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes('anchor-apply-proposer')));
const proposerId = proposer.address.toLowerCase();
const entityId = `0x${'00'.repeat(31)}2a`;
const jurisdictionRef = 'eip155:31337:0x5fbdb2315678afecb367f032d93f642f64180aa3';
const jurisdiction = {
  chainId: 31337,
  depositoryAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  entityProviderAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  entityProviderDeploymentBlock: 10,
};
const registrationBase = 9;
const anchorHeight = 2049;
const anchorBlockHash = ethers.keccak256(ethers.toUtf8Bytes('anchor-block'));
const stateRoot = ethers.keccak256(ethers.toUtf8Bytes('anchor-state-root'));
const stackKey = getCertifiedBoardStackKey(jurisdiction);

const record = (id: string, epoch: number): CertifiedBoardRecord => ({
  stackKey,
  entityId: id,
  boardHash: ethers.keccak256(ethers.toUtf8Bytes(`board-${id}-${epoch}`)),
  boardEpoch: epoch,
  previousBoardHash: epoch > 0 ? ethers.keccak256(ethers.toUtf8Bytes(`board-${id}-${epoch - 1}`)) : ethers.ZeroHash,
  previousBoardValidUntil: epoch > 0 ? 1_900_000_000 : 0,
  source: epoch > 0 ? 'BoardActivated' : 'EntityRegistered',
});
const foundationId = `0x${'00'.repeat(31)}01`;
const boardRecords = [record(foundationId, 0), record(entityId, 2)];
const carriedValues = (): JHistoryAnchorValues => ({
  tokenCount: 3n,
  boardRecords,
  reserves: new Map([[1, 500n], [2, 0n]]),
  batchNonce: 4n,
  actionNonce: 7n,
});

// Storage side, built independently of the writer from the same canonical leaf builders.
const storageRoot = (values: JHistoryAnchorValues): string => {
  let root = EMPTY_CERTIFIED_BOARD_ROOT;
  const nodes = new Map();
  for (const entry of values.boardRecords) {
    const put = putCertifiedBoardRecord(nodes, root, entry);
    for (const [hash, node] of put.newNodes) nodes.set(hash, node);
    root = put.root;
  }
  return buildProvenValuesRoot({
    jurisdiction,
    entityId,
    blockNumber: anchorHeight,
    blockHash: anchorBlockHash,
    boardRegistryRoot: root,
    reserveRoot: buildReserveAnchorRoot(values.tokenCount, new Map([[entityId, new Map(values.reserves)]])),
    debtRoot: buildDebtAnchorRoot(debtViewFromLedgers(entityId, undefined, undefined)),
    nonceRoot: buildNonceAnchorRoot([nonceViewFromStorage(entityId, values.batchNonce, values.actionNonce ?? 0n)]),
  }).root;
};

const carriedRoot = (values: JHistoryAnchorValues): string =>
  buildCarriedProvenValues({ jurisdiction, entityId, blockNumber: anchorHeight, blockHash: anchorBlockHash, values }).root;

const genesisState = (): EntityState => ({
  entityId,
  height: 5,
  lastFinalizedJHeight: registrationBase,
  reserves: new Map(),
  config: { jurisdiction },
  entityProviderActionState: { version: 1, confirmedNonce: 0n, generation: 3 },
} as unknown as EntityState);

const admit = (provenValuesRoot: string) => {
  const unsigned = {
    from: proposerId, jurisdictionRef, baseHeight: registrationBase, anchorHeight, anchorBlockHash, stateRoot, provenValuesRoot,
  };
  const signature = proposer.signingKey.sign(
    buildJHistoryAnchorClaimDigest({ ...unsigned, entityId, signerId: proposerId }),
  ).serialized;
  const validated = validateJHistoryAnchorClaim({
    entityId,
    state: genesisState(),
    expectedJurisdictionRef: jurisdictionRef,
    activeProposerId: proposerId,
    data: { ...unsigned, signature },
    recomputedValuesRoot: provenValuesRoot,
    verifySignature: (signerId, digest, sig) => ethers.recoverAddress(digest, sig).toLowerCase() === signerId,
  });
  if (!validated.ok) throw new Error(validated.code);
  return { validated, signature };
};

const apply = (values: JHistoryAnchorValues, claimRoot = storageRoot(carriedValues()), state = genesisState()) => {
  const env = {} as EntityRuntimeContext;
  const { validated, signature } = admit(claimRoot);
  const run = () => applyJHistoryAnchor({
    entityState: genesisState(),
    state,
    env,
    validated,
    signature,
    values,
    recomputeValuesRoot: (after, tokenCount) => buildEntityProvenValuesFromFold(after, jurisdiction, tokenCount).root,
  });
  return { env, validated, run };
};

describe('J history anchor apply', () => {
  test('writes the anchor start whose fold root equals the signed storage root', () => {
    const { env, validated, run } = apply(carriedValues());
    const after = run();
    expect(buildEntityProvenValuesFromFold(after, jurisdiction, 3n).root).toBe(storageRoot(carriedValues()));
    expect(carriedRoot(carriedValues())).toBe(storageRoot(carriedValues()));
    expect(after.jHistoryFinality?.eventHistoryRoot).toBe(buildJHistoryAnchorRoot(validated.anchor));
    expect(after.jHistoryFinality).toMatchObject({
      baseHeight: registrationBase, finalizedThroughHeight: anchorHeight, tipBlockHash: anchorBlockHash, entityHeight: 6,
    });
    expect(after.lastFinalizedJHeight).toBe(anchorHeight);
    expect(after.certifiedBoardState?.eventHistoryRoot).toBe(validated.eventHistoryRoot);
    expect([...after.reserves]).toEqual([[1, 500n]]);
    expect(after.entityProviderActionState).toEqual({ version: 1, confirmedNonce: 7n, generation: 3 });
    expect(after.jBatchState?.entityNonce).toBe(4);
    const nodes = getCertifiedBoardNodeStore(env);
    const root = after.certifiedBoardState?.boardRegistryRoot ?? '';
    for (const entry of boardRecords) expect(lookupCertifiedBoardRecord(nodes, root, stackKey, entry.entityId)).toEqual(entry);
  });

  test('never commits carried values that do not reproduce the signed root', () => {
    for (const values of [
      { ...carriedValues(), reserves: new Map([[1, 501n]]) },
      { ...carriedValues(), boardRecords: boardRecords.slice(0, 1) },
      { ...carriedValues(), batchNonce: 5n },
    ]) {
      expect(carriedRoot(values)).not.toBe(storageRoot(carriedValues()));
      const { env, run } = apply(values);
      expect(run).toThrow('J_ANCHOR_APPLY_VALUES_ROOT_MISMATCH');
      expect(getCertifiedBoardNodeStore(env).size).toBe(0);
    }
  });

  test('fails closed on families the anchor cannot prove', () => {
    expect(apply({ ...carriedValues(), actionNonce: null }).run).toThrow('J_ANCHOR_APPLY_ACTION_NONCE_UNPROVEN');
    expect(apply({ ...carriedValues(), reserves: new Map([[3, 1n]]) }).run).toThrow('J_ANCHOR_APPLY_RESERVE_UNLISTED');
    const indebted = genesisState();
    indebted.inDebtsByToken = new Map([[1, new Map([['d', {} as never]])]]);
    expect(apply(carriedValues(), undefined, indebted).run).toThrow('J_ANCHOR_APPLY_DEBT_PRESENT');
  });
});

const signedTx = (values: JHistoryAnchorValues, height = anchorHeight, signer = proposer): JHistoryAnchorTxData => {
  const blockHash = height === anchorHeight ? anchorBlockHash : ethers.keccak256(ethers.toUtf8Bytes(`anchor-${height}`));
  // The values root binds the anchor block, so a claim at another height roots its own block.
  const provenValuesRoot = height === anchorHeight
    ? storageRoot(carriedValues())
    : buildCarriedProvenValues({ jurisdiction, entityId, blockNumber: height, blockHash, values: carriedValues() }).root;
  const unsigned = {
    from: signer.address.toLowerCase(), jurisdictionRef: getJEventJurisdictionRef(jurisdiction),
    baseHeight: registrationBase, anchorHeight: height,
    anchorBlockHash: blockHash, stateRoot, provenValuesRoot,
  };
  const signed = signer.signingKey.sign(buildJHistoryAnchorClaimDigest({ ...unsigned, entityId, signerId: unsigned.from }));
  // Canonical compact form: r || s || recovery(0|1).
  const signature = ethers.concat([signed.r, signed.s, signed.v === 27 ? '0x00' : '0x01']).toLowerCase();
  return { ...unsigned, signature, values };
};

const validatorState = (): EntityState => {
  // Same minimal full Entity shape as entity-provider-action-flow.test.ts baseState.
  const state = {
    ...genesisState(),
    entityEncryptionPublicKey: `0x${'44'.repeat(32)}`,
    timestamp: 1,
    nonces: new Map(),
    proposals: new Map(),
    accounts: PersistentEntityAccountMap.empty(entityId, computeEntityAccountValueHash),
    profile: { name: '', isHub: false, avatar: '', bio: '', website: '' },
    paybook: { entries: new Map(), feesEarned: 0n },
  } as EntityState;
  (state as unknown as { config: unknown }).config = {
    jurisdiction, mode: 'proposer-based', threshold: 1n, validators: [proposerId], shares: { [proposerId]: 1n },
  };
  return state;
};

const halts = (run: () => unknown, code: string): void => {
  let thrown: unknown;
  try { run(); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(FailureDispositionError);
  const failure = thrown as FailureDispositionError;
  expect(`${failure.code} ${failure.message}`).toContain(code);
};

describe('j_anchor Entity transaction', () => {
  test('ingress admits the exact payload shape and nothing else', () => {
    const tx = { type: 'j_anchor', data: signedTx(carriedValues()) };
    expect(validateEntityTx(tx, 'TX').type).toBe('j_anchor');
    expect(() => validateEntityTx({ type: 'j_anchor', data: { ...tx.data, extra: 1 } }, 'TX')).toThrow('TX_DATA_FIELDS');
    const plainReserves = { ...tx.data, values: { ...tx.data.values, reserves: { 1: 500n } } };
    expect(() => validateEntityTx({ type: 'j_anchor', data: plainReserves }, 'TX')).toThrow('TX_DATA_RESERVES');
    const negative = { ...tx.data, values: { ...tx.data.values, reserves: new Map([[1, -1n]]) } };
    expect(() => validateEntityTx({ type: 'j_anchor', data: negative }, 'TX')).toThrow('TX_DATA_RESERVE_AMOUNT');
  });

  test('admits once, then an authenticated redelivery is a no-op', () => {
    const env = { quietRuntimeLogs: true } as EntityRuntimeContext;
    const before = validatorState();
    const data = signedTx(carriedValues());
    const after = applyJAnchor(before, data, env);
    expect(before.jHistoryFinality).toBeUndefined();
    expect(buildEntityProvenValuesFromFold(after, jurisdiction, 3n).root).toBe(storageRoot(carriedValues()));
    expect(after.jHistoryFinality).toMatchObject({ finalizedThroughHeight: anchorHeight, proposerSignerId: proposerId });
    expect(after.jHistoryFinality?.proposerSignature).toBe(data.signature.toLowerCase());
    const cached = getCertifiedBoardNodeStore(env).size;
    expect(applyJAnchor(after, data, env)).toBe(after);
    expect(getCertifiedBoardNodeStore(env).size).toBe(cached);
    // Authentication precedes the no-op: a forged redelivery still halts.
    const forged = signedTx(carriedValues(), anchorHeight, new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes('x'))));
    halts(() => applyJAnchor(after, { ...forged, from: proposerId }, env), 'J_ANCHOR_PROPOSER_SIGNATURE_INVALID');
    // A different, higher anchor over existing finality is never a second start.
    halts(() => applyJAnchor(after, signedTx(carriedValues(), anchorHeight + 1), env), 'J_ANCHOR_FINALITY_EXISTS');
  });

  test('travels the protocol lane like j_event, never a user command or collective action', () => {
    // The handler authenticates the signed claim itself (proposer signature
    // above); a board command or collective proposal must not carry it.
    const tx = { type: 'j_anchor' as const, data: signedTx(carriedValues()) };
    expect(isEntityProtocolTx(tx)).toBe(true);
    expect(isIndividualEntityCommandTx(tx)).toBe(false);
    expect(isCollectiveEntityActionTx(tx)).toBe(false);
    expect(() => assertEntityCommandTxs([tx])).toThrow('ENTITY_COMMAND_PROTOCOL_TX_FORBIDDEN:j_anchor');
    expect(() => buildEntityTransactionProposalAction([tx])).toThrow('ENTITY_COLLECTIVE_ACTION_TX_FORBIDDEN:j_anchor');
  });

  test('the proposer builder signs with its own key the exact claim the handler admits', () => {
    const env = { quietRuntimeLogs: true, runtimeSeed: 'anchor-apply-builder' } as EntityRuntimeContext;
    registerSignerKey(env, proposerId, ethers.getBytes(proposer.privateKey));
    const header = { anchorHeight, anchorBlockHash, stateRoot };
    const tx = buildJAnchorTx(env, validatorState(), proposerId.toUpperCase(), header, carriedValues());
    // Same bytes as the independently signed claim (deterministic secp256k1).
    expect(tx).toEqual({ type: 'j_anchor', data: signedTx(carriedValues()) });
    expect(validateEntityTx(tx, 'TX').type).toBe('j_anchor');
    const after = applyJAnchor(validatorState(), tx.data, env);
    expect(after.jHistoryFinality?.finalizedThroughHeight).toBe(anchorHeight);
    expect(buildEntityProvenValuesFromFold(after, jurisdiction, 3n).root).toBe(storageRoot(carriedValues()));
    // A runtime without the proposer key cannot produce the claim at all.
    const stranger = { quietRuntimeLogs: true, runtimeSeed: 'anchor-apply-stranger' } as EntityRuntimeContext;
    expect(() => buildJAnchorTx(stranger, validatorState(), proposerId, header, carriedValues()))
      .toThrow('MISSING_SIGNER_KEY');
    // Another proposer's signature over the same claim is never admitted.
    const outsider = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes('outsider')));
    registerSignerKey(stranger, outsider.address, ethers.getBytes(outsider.privateKey));
    const foreign = buildJAnchorTx(stranger, validatorState(), outsider.address, header, carriedValues());
    halts(
      () => applyJAnchor(validatorState(), { ...foreign.data, from: proposerId }, env),
      'J_ANCHOR_PROPOSER_SIGNATURE_INVALID',
    );
  });

  test('halts on a non-proposer sender or carried values off the signed root', () => {
    const env = { quietRuntimeLogs: true } as EntityRuntimeContext;
    const outsider = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes('outsider')));
    halts(() => applyJAnchor(validatorState(), signedTx(carriedValues(), anchorHeight, outsider), env), 'J_ANCHOR_NOT_ACTIVE_PROPOSER');
    const tampered = { ...carriedValues(), reserves: new Map([[1, 501n]]) };
    halts(() => applyJAnchor(validatorState(), signedTx(tampered), env), 'J_ANCHOR_VALUES_ROOT_MISMATCH');
    expect(getCertifiedBoardNodeStore(env).size).toBe(0);
  });
});
