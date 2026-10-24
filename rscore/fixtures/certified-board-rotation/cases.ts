/**
 * TypeScript oracle for the certified board a live process answers with after a
 * mid-run rotation.
 *
 * The vector walks one jurisdiction stack through FoundationBootstrapped,
 * EntityRegistered and BoardActivated and records, after every step, the board
 * that `resolveObserverCertifiedBoardRecord` returns for the peer plus the
 * committed `boardRegistryRoot`. Rust replays the same three J events through
 * `apply_finalized_j_event_batches` and must answer with the same record from
 * the same committed state, without a restore in between.
 */
import { initCrontab } from '../../../core/entity/scheduler';
import { PersistentEntityAccountMap } from '../../../core/entity/state/persistent-account-map';
import { PersistentEntityCollectionMap } from '../../../core/entity/state/persistent-collection-map';
import { computeEntityAccountValueHash } from '../../../core/entity/consensus/state-root';
import {
  applyCertifiedBoardRegistryEvent,
  cacheCertifiedBoardNodes,
  getCertifiedBoardNodeStore,
  getCertifiedBoardStackKey,
  resolveObserverCertifiedBoardRecord,
} from '../../../core/jurisdiction/machine/board-registry';
import type { EntityRuntimeContext } from '../../../core/entity/runtime-context';
import type { EntityState } from '../../../core/entity/types';
import type { EntityTx } from '../../../core/types/entity-tx';
import type { JurisdictionEvent } from '../../../core/types/jurisdiction-events';

const OWNER = `0x${'11'.repeat(32)}`;
/** The peer id must equal its EntityProvider entity number. */
const PEER_NUMBER = 3n;
const PEER = `0x${PEER_NUMBER.toString(16).padStart(64, '0')}`;
const FOUNDATION_BOARD = `0x${'a1'.repeat(32)}`;
const REGISTERED_BOARD = `0x${'b2'.repeat(32)}`;
const ROTATED_BOARD = `0x${'c3'.repeat(32)}`;
const PREVIOUS_BOARD_VALID_UNTIL = 1_700_604_800;

export const JURISDICTION = {
  name: 'CertifiedBoardRotationFixture',
  address: 'rpc://certified-board-rotation-fixture',
  chainId: 31_337,
  blockTimeMs: 1_000,
  depositoryAddress: `0x${'88'.repeat(20)}`,
  entityProviderAddress: `0x${'99'.repeat(20)}`,
};

const observerState = (): EntityState => ({
  entityId: OWNER,
  entityEncryptionPublicKey: `0x${'55'.repeat(32)}`,
  height: 0,
  timestamp: 2_000,
  nonces: new Map(),
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [OWNER],
    shares: { [OWNER]: 1n },
    jurisdiction: JURISDICTION,
  },
  reserves: new Map(),
  accounts: PersistentEntityAccountMap.empty(OWNER, computeEntityAccountValueHash),
  lastFinalizedJHeight: 0,
  profile: { name: 'certified-board-rotation-fixture', isHub: true, avatar: '', bio: '', website: '' },
  paybook: { entries: PersistentEntityCollectionMap.empty('paybookHashlock'), feesEarned: 0n },
  crontabState: initCrontab(),
});

const context = (): EntityRuntimeContext => ({
  state: { eReplicas: new Map(), jReplicas: new Map(), height: 0, timestamp: 2_000 },
  runtimeSeed: 'certified-board-rotation-fixture',
  activeJurisdiction: JURISDICTION.name,
  infrastructure: { certifiedBoardNodes: new Map() },
  error: () => undefined,
  info: () => undefined,
});

const metadata = (blockNumber: number, blockByte: string, txByte: string, logIndex: number) => ({
  blockNumber,
  blockHash: `0x${blockByte.repeat(32)}`,
  transactionHash: `0x${txByte.repeat(32)}`,
  logIndex,
});

const EVENTS: readonly { readonly name: string; readonly event: JurisdictionEvent }[] = [
  {
    name: 'FoundationBootstrapped',
    event: {
      type: 'FoundationBootstrapped',
      ...metadata(1, '10', '20', 0),
      data: {
        recipient: `0x${'77'.repeat(20)}`,
        boardHash: FOUNDATION_BOARD,
        controlTokenId: '1',
        dividendTokenId: '2',
      },
    } as unknown as JurisdictionEvent,
  },
  {
    name: 'EntityRegistered',
    event: {
      type: 'EntityRegistered',
      ...metadata(2, '11', '21', 0),
      data: { entityId: PEER, entityNumber: PEER_NUMBER.toString(), boardHash: REGISTERED_BOARD },
    } as unknown as JurisdictionEvent,
  },
  {
    name: 'BoardActivated',
    event: {
      type: 'BoardActivated',
      ...metadata(3, '12', '22', 0),
      data: {
        entityId: PEER,
        previousBoardHash: REGISTERED_BOARD,
        newBoardHash: ROTATED_BOARD,
        previousBoardValidUntil: PREVIOUS_BOARD_VALID_UNTIL,
      },
    } as unknown as JurisdictionEvent,
  },
];

/**
 * Replay the rotation through the production TypeScript board registry and
 * report what the observer resolves after each committed step.
 */
export const executeCertifiedBoardRotationVector = () => {
  const env = context();
  const state = observerState();
  const steps = EVENTS.map(({ name, event }) => {
    const applied = applyCertifiedBoardRegistryEvent(
      state.certifiedBoardState,
      getCertifiedBoardNodeStore(env),
      JURISDICTION,
      event,
    );
    cacheCertifiedBoardNodes(env, applied.newNodes);
    state.certifiedBoardState = applied.state;
    return {
      event: name,
      jHeight: Number((event as unknown as { blockNumber: number }).blockNumber),
      boardRegistryRoot: applied.state.boardRegistryRoot,
      resolvedPeerBoard: resolveObserverCertifiedBoardRecord(state, getCertifiedBoardNodeStore(env), PEER),
    };
  });
  return {
    version: 1,
    canonicalSource: 'TypeScript production certified board registry',
    jurisdiction: JURISDICTION,
    stackKey: getCertifiedBoardStackKey(JURISDICTION),
    ownerEntityId: OWNER,
    peerEntityId: PEER,
    peerEntityNumber: PEER_NUMBER.toString(),
    events: EVENTS.map(({ name, event }) => ({ name, event })),
    steps,
  };
};

/**
 * Intra-frame ordering oracle.
 *
 * One Entity frame carries a `j_event` whose certified J range activates the
 * peer's new board, followed by an `accountInput` from that same peer.
 * `applyEntityTxsInOrder` (`core/entity/consensus/frame/application.ts`) walks
 * the frame's transactions strictly in order and the certified J range is
 * prepended to the proposal (`core/entity/consensus/proposal/selection.ts`), so
 * the board handler (`core/entity/tx/j-events-board.ts`) commits before
 * `prepareAccountConsensusRun` (`core/entity/tx/handlers/account/input-phases.ts`)
 * resolves the counterparty board for the row.
 *
 * Rust freezes that same resolution from the state at the START of the frame
 * (`rscore/crates/runtime/src/machine/apply.rs`), before the kernel applies the
 * frame's J events (`rscore/crates/entity-kernel/src/resident.rs`). The Rust
 * twin of this vector is
 * `rscore/crates/runtime/tests/certified_board_rotation_parity.rs`.
 */
export const executeIntraFrameBoardOrderingVector = () => {
  const env = context();
  const state = observerState();
  const commit = (index: number): void => {
    const event = EVENTS[index]?.event;
    if (!event) throw new Error(`CERTIFIED_BOARD_ORDERING_EVENT_MISSING:${index}`);
    // Exactly what the `j_event` board handler does per event.
    const applied = applyCertifiedBoardRegistryEvent(
      state.certifiedBoardState,
      getCertifiedBoardNodeStore(env),
      JURISDICTION,
      event,
    );
    cacheCertifiedBoardNodes(env, applied.newNodes);
    state.certifiedBoardState = applied.state;
  };
  // Committed history before this frame: the foundation and the peer's registration.
  commit(0);
  commit(1);
  // Exactly what `prepareAccountConsensusRun` resolves for a row from this peer.
  const resolve = () => resolveObserverCertifiedBoardRecord(state, getCertifiedBoardNodeStore(env), PEER);
  const beforeFrame = resolve();
  // This frame's first transaction: the certified J range carrying BoardActivated.
  commit(2);
  // This frame's second transaction: the peer's accountInput.
  const accountInputResolved = resolve();
  return {
    version: 1,
    canonicalSource: 'TypeScript production Entity frame transaction order',
    ownerEntityId: OWNER,
    peerEntityId: PEER,
    registeredBoardHash: REGISTERED_BOARD,
    rotatedBoardHash: ROTATED_BOARD,
    beforeFrame,
    accountInputResolved,
  };
};

/**
 * The exact Entity frame the owner forbade.
 *
 * One `j_event` whose certified J range activates the PEER's board at J height
 * 3, log index 0, plus one `accountInput` from that same peer — the TypeScript
 * twin of `board_hanko_refresh_row` in
 * `rscore/crates/runtime/tests/certified_board_rotation_parity.rs`. Both engines
 * must refuse this list: TypeScript defers the row at proposal
 * (`withoutCounterpartyBoardActivationConflicts`) and rejects the frame at
 * validation (`PROPOSAL_COUNTERPARTY_BOARD_ACTIVATION_MIXED`); Rust refuses it
 * in `apply_resident_entity_round` before any mutation.
 */
export const intraFrameMixedBoardActivationFrame = (): EntityTx[] => {
  const rotation = EVENTS[2]?.event;
  if (!rotation) throw new Error('CERTIFIED_BOARD_ORDERING_ROTATION_MISSING');
  const jRange: EntityTx = {
    type: 'j_event',
    data: {
      from: OWNER,
      jurisdictionRef: JURISDICTION.name,
      baseHeight: 2,
      scannedThroughHeight: 3,
      tipBlockHash: `0x${'12'.repeat(32)}`,
      eventHistoryRoot: `0x${'00'.repeat(32)}`,
      rangeHash: `0x${'00'.repeat(32)}`,
      blocks: [
        {
          blockNumber: 3,
          blockHash: `0x${'12'.repeat(32)}`,
          eventsHash: `0x${'00'.repeat(32)}`,
          events: [rotation],
        },
      ],
      signature: `0x${'00'.repeat(65)}`,
      observedAt: 2_000,
    },
  };
  const peerRow: EntityTx = {
    type: 'accountInput',
    data: {
      fromEntityId: PEER,
      toEntityId: OWNER,
      domain: { chainId: JURISDICTION.chainId, depositoryAddress: JURISDICTION.depositoryAddress },
      disputeConfig: { disputePeriodSeconds: 10, cooperativeCloseSeconds: 10 },
      kind: 'board_hanko_refresh',
      boardHankoRefresh: {
        height: 1,
        frameHash: `0x${'5a'.repeat(32)}`,
        boardEpoch: 1,
      },
    },
  } as unknown as EntityTx;
  return [jRange, peerRow];
};
