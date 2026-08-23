import { describe, expect, test } from 'bun:test';

import type { SettlementWorkspace } from '../../../types/account';
import {
  assertSettlementWorkspacePhase,
  isReadySettlementWorkspace,
  isHankoPendingSettlementWorkspace,
  isSubmittedSettlementWorkspace,
  isUnsignedSettlementWorkspace,
} from '../../../account/tx/handlers/settlement/workspace-views';

const unsigned = (): SettlementWorkspace => ({
  workspaceHash: `0x${'11'.repeat(32)}`,
  ops: [{ type: 'forgive', tokenId: 1 }],
  lastModifiedByLeft: true,
  status: 'awaiting_counterparty',
  revision: 1,
  createdAt: 1,
  lastUpdatedAt: 1,
  executorIsLeft: true,
});

const pinned = (): SettlementWorkspace => ({
  ...unsigned(),
  compiledDiffs: [],
  compiledForgiveTokenIds: [1],
  settlementHash: `0x${'22'.repeat(32)}`,
  nonceAtSign: 1,
  postSettlementDisputeProof: {
    disputeHash: `0x${'33'.repeat(32)}`,
    proofBodyHash: `0x${'44'.repeat(32)}`,
    nonce: 2,
    proposerIsLeft: true,
    leftHanko: 'left-post',
  },
});

const ready = (executorIsLeft: boolean): SettlementWorkspace => ({
  ...pinned(),
  status: 'ready_to_submit',
  executorIsLeft,
  ...(executorIsLeft ? { rightHanko: 'right-settlement' } : { leftHanko: 'left-settlement' }),
  postSettlementDisputeProof: {
    ...pinned().postSettlementDisputeProof!,
    rightHanko: 'right-post',
  },
});

const replace = (
  workspace: SettlementWorkspace,
  patch: Record<string, unknown>,
): SettlementWorkspace => ({ ...workspace, ...patch }) as SettlementWorkspace;

describe('FinTS settlement workspace phases', () => {
  test('recognizes unsigned and partially Hanko-authorized workspace phases', () => {
    expect(isUnsignedSettlementWorkspace(unsigned())).toBe(true);
    expect(isUnsignedSettlementWorkspace({ ...unsigned(), status: 'draft' })).toBe(true);
    expect(isHankoPendingSettlementWorkspace(pinned())).toBe(true);
    expect(assertSettlementWorkspacePhase(unsigned(), 'TEST')).toEqual(unsigned());
    expect(assertSettlementWorkspacePhase(pinned(), 'TEST')).toEqual(pinned());
  });

  test('requires the non-executor settlement Hanko and both post-proof Hankos', () => {
    const leftExecutor = ready(true);
    const rightExecutor = ready(false);
    expect(isReadySettlementWorkspace(leftExecutor)).toBe(true);
    expect(isReadySettlementWorkspace(rightExecutor)).toBe(true);
    expect(assertSettlementWorkspacePhase(leftExecutor, 'TEST')).toBe(leftExecutor);
    for (const candidate of [leftExecutor, rightExecutor]) {
      const submitted = { ...candidate, status: 'submitted' as const };
      expect(isSubmittedSettlementWorkspace(submitted)).toBe(true);
      expect(assertSettlementWorkspacePhase(submitted, 'TEST')).toBe(submitted);
    }
  });

  test('unsigned phase rejects every signed or pinned field', () => {
    const populated: Record<string, unknown> = {
      compiledDiffs: [],
      compiledForgiveTokenIds: [],
      leftHanko: 'left',
      rightHanko: 'right',
      settlementHash: 'hash',
      nonceAtSign: 1,
      postSettlementDisputeProof: pinned().postSettlementDisputeProof,
    };
    for (const [field, value] of Object.entries(populated)) {
      expect(isUnsignedSettlementWorkspace(replace(unsigned(), { [field]: value })), field).toBe(false);
    }
  });

  test('pinned phases require every exact body field', () => {
    const invalidPatches: Array<readonly [string, Record<string, unknown>]> = [
      ['diffs-missing', { compiledDiffs: undefined }],
      ['diffs-not-array', { compiledDiffs: {} }],
      ['forgive-missing', { compiledForgiveTokenIds: undefined }],
      ['forgive-not-array', { compiledForgiveTokenIds: {} }],
      ['hash-missing', { settlementHash: undefined }],
      ['hash-empty', { settlementHash: '' }],
      ['hash-not-text', { settlementHash: 1 }],
      ['nonce-missing', { nonceAtSign: undefined }],
      ['nonce-zero', { nonceAtSign: 0 }],
      ['nonce-unsafe', { nonceAtSign: Number.MAX_SAFE_INTEGER + 1 }],
      ['post-proof-missing', { postSettlementDisputeProof: undefined }],
    ];
    for (const [label, patch] of invalidPatches) {
      expect(isHankoPendingSettlementWorkspace(replace(pinned(), patch)), label).toBe(false);
      expect(isReadySettlementWorkspace(replace(ready(true), patch)), label).toBe(false);
    }
    const noPostHanko = replace(pinned(), {
      postSettlementDisputeProof: {
        ...pinned().postSettlementDisputeProof,
        leftHanko: undefined,
      },
    });
    expect(isHankoPendingSettlementWorkspace(noPostHanko)).toBe(false);
    expect(isHankoPendingSettlementWorkspace({ ...pinned(), status: 'draft' })).toBe(false);
  });

  test('ready and submitted phases bind status, both post proofs, and exact non-executor Hanko', () => {
    for (const executorIsLeft of [true, false]) {
      const candidate = ready(executorIsLeft);
      const wrongSettlementHanko = executorIsLeft
        ? { leftHanko: 'left', rightHanko: undefined }
        : { leftHanko: undefined, rightHanko: 'right' };
      const bothSettlementHankos = { leftHanko: 'left', rightHanko: 'right' };
      for (const patch of [wrongSettlementHanko, bothSettlementHankos]) {
        expect(isReadySettlementWorkspace(replace(candidate, patch))).toBe(false);
      }
      for (const missing of ['leftHanko', 'rightHanko'] as const) {
        const postProof = { ...candidate.postSettlementDisputeProof, [missing]: undefined };
        expect(isReadySettlementWorkspace(replace(candidate, { postSettlementDisputeProof: postProof }))).toBe(false);
      }
      expect(isReadySettlementWorkspace({ ...candidate, status: 'submitted' })).toBe(false);
      expect(isSubmittedSettlementWorkspace(candidate)).toBe(false);
    }
  });

  test('rejects impossible signed status combinations', () => {
    const impossible = { ...unsigned(), status: 'ready_to_submit' as const };
    expect(() => assertSettlementWorkspacePhase(impossible, 'TEST')).toThrow(
      'TEST_PHASE_INVALID:ready_to_submit',
    );
  });
});
