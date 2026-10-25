import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  executeCertifiedBoardRotationVector,
  executeIntraFrameBoardOrderingVector,
  intraFrameMixedBoardActivationFrame,
} from '../../../../rscore/fixtures/certified-board-rotation/cases';
import {
  findCounterpartyBoardActivationConflict,
  withoutCounterpartyBoardActivationConflicts,
} from '../../../entity/consensus/proposal/policy';
import { safeStringify } from '../../../protocol/serialization';

const fixturePath = join(
  import.meta.dir,
  '../../../../rscore/fixtures/certified-board-rotation/rotation-v1.json',
);

test('certified board rotation vector matches the committed Rust/TypeScript fixture', () => {
  const actual = JSON.parse(safeStringify(executeCertifiedBoardRotationVector()));
  const expected = JSON.parse(readFileSync(fixturePath, 'utf8'));
  expect(actual).toEqual(expected);
});

test('resolveObserverCertifiedBoardRecord answers the new board right after BoardActivated', () => {
  const vector = executeCertifiedBoardRotationVector();
  const [bootstrapped, registered, rotated] = vector.steps;

  expect(bootstrapped?.event).toBe('FoundationBootstrapped');
  expect(bootstrapped?.resolvedPeerBoard).toBeNull();

  expect(registered?.event).toBe('EntityRegistered');
  expect(registered?.resolvedPeerBoard?.entityId).toBe(vector.peerEntityId);
  expect(registered?.resolvedPeerBoard?.boardEpoch).toBe(0);

  // The divergence this vector guards: the observer must resolve the rotated
  // board from committed Entity state in the same process, with no restore.
  // Rust asserts the same three roots and records through
  // `RuntimeEntityState::certified_board_authority` in
  // rscore/crates/runtime/tests/certified_board_rotation_parity.rs.
  expect(rotated?.event).toBe('BoardActivated');
  expect(rotated?.resolvedPeerBoard?.source).toBe('BoardActivated');
  expect(rotated?.resolvedPeerBoard?.boardEpoch).toBe(1);
  expect(rotated?.resolvedPeerBoard?.previousBoardHash).toBe(registered?.resolvedPeerBoard?.boardHash);
  expect(rotated?.resolvedPeerBoard?.boardHash).not.toBe(registered?.resolvedPeerBoard?.boardHash);
  expect(rotated?.boardRegistryRoot).not.toBe(registered?.boardRegistryRoot);
});

// ---------------------------------------------------------------------------
// Intra-frame ordering: the frame shape is FORBIDDEN.
//
// TypeScript applies one Entity frame's transactions strictly in order
// (`core/entity/consensus/frame/application.ts`, `applyEntityTxsInOrder`) with
// the certified J range prepended (`core/entity/consensus/proposal/selection.ts`),
// so a `j_event` activating a counterparty's board commits
// (`core/entity/tx/j-events-board.ts`) before `prepareAccountConsensusRun`
// resolves that counterparty's board for a later `accountInput`
// (`core/entity/tx/handlers/account/input-phases.ts`): the row is verified
// against the NEW board. Rust freezes the same resolution from start-of-frame
// state (`rscore/crates/runtime/src/machine/apply.rs`) and applies the frame's J
// events only after the whole Account ingress wave
// (`rscore/crates/entity-kernel/src/resident.rs`): the RETIRED board. Both are
// rejects, so the fork was silent.
//
// `05a90c88e` recorded the split and presented the fork; the owner chose to
// forbid the frame shape. These tests keep that evidence and now prove the
// refusal. The Rust half lives in
// `rscore/crates/runtime/tests/certified_board_rotation_parity.rs`.
// ---------------------------------------------------------------------------

test('the two frame orders resolve different counterparty boards', () => {
  const ordering = executeIntraFrameBoardOrderingVector();

  // What Rust resolves for the whole frame, and what TypeScript resolved before
  // the frame's `j_event` transaction: the retired registration board.
  expect(ordering.beforeFrame?.boardHash).toBe(ordering.registeredBoardHash);
  expect(ordering.beforeFrame?.boardEpoch).toBe(0);
  expect(ordering.beforeFrame?.source).toBe('EntityRegistered');

  // What TypeScript resolves for an `accountInput` placed after that `j_event`
  // in the SAME frame: the board the frame just activated.
  expect(ordering.accountInputResolved?.boardHash).toBe(ordering.rotatedBoardHash);
  expect(ordering.accountInputResolved?.boardEpoch).toBe(1);
  expect(ordering.accountInputResolved?.source).toBe('BoardActivated');

  // One row, one frame, two certified boards. That is why the shape is refused.
  expect(ordering.accountInputResolved?.boardHash).not.toBe(ordering.beforeFrame?.boardHash);
});

test('a proposer may not select a counterparty accountInput into that counterparty\'s activation frame', () => {
  const ordering = executeIntraFrameBoardOrderingVector();
  const mempool = intraFrameMixedBoardActivationFrame();
  expect(mempool.map(tx => tx.type)).toEqual(['j_event', 'accountInput']);

  // The certified J range keeps priority; the counterparty's row stays in the
  // mempool and is proposed once the activation is committed.
  const proposable = withoutCounterpartyBoardActivationConflicts(ordering.ownerEntityId, mempool);
  expect(proposable.map(tx => tx.type)).toEqual(['j_event']);

  // The rule is targeted: without the activation the same row is proposable.
  const rowOnly = mempool.filter(tx => tx.type === 'accountInput');
  expect(
    withoutCounterpartyBoardActivationConflicts(ordering.ownerEntityId, rowOnly).map(tx => tx.type),
  ).toEqual(['accountInput']);
});

test('a validator refuses a frame that mixes a counterparty board activation with that counterparty\'s row', () => {
  const ordering = executeIntraFrameBoardOrderingVector();
  const frameTxs = intraFrameMixedBoardActivationFrame();

  // `preauthenticateEntityProposal` returns the typed reject
  // `PROPOSAL_COUNTERPARTY_BOARD_ACTIVATION_MIXED` on exactly this answer, so a
  // proposer that ignores the policy above cannot commit the frame anyway.
  expect(findCounterpartyBoardActivationConflict(ordering.ownerEntityId, frameTxs))
    .toBe(ordering.peerEntityId.toLowerCase());

  // Neither half alone is refused.
  expect(
    findCounterpartyBoardActivationConflict(
      ordering.ownerEntityId,
      frameTxs.filter(tx => tx.type === 'j_event'),
    ),
  ).toBeNull();
  expect(
    findCounterpartyBoardActivationConflict(
      ordering.ownerEntityId,
      frameTxs.filter(tx => tx.type === 'accountInput'),
    ),
  ).toBeNull();
});
