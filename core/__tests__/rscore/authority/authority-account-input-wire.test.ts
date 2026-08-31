import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  beginAuthorityFrame,
  buildAuthorityWave,
  noteAuthorityAccountInputResult,
  noteAuthorityEntityClock,
  noteRawAccountInput,
  resetAuthorityRecordForTests,
} from '../../../rscore/authority-wave';
import type {
  AccountFrame,
  AccountInput,
  AccountReplica,
} from '../../../types/account';

const OWNER = `0x${'aa'.repeat(32)}`;
const PEER = `0x${'bb'.repeat(32)}`;
const DEPOSITORY = `0x${'11'.repeat(20)}`;
const WATCH_SEED = `0x${'22'.repeat(32)}`;
const PREVIOUS_HASH = `0x${'31'.repeat(32)}`;
const STATE_ROOT = `0x${'32'.repeat(32)}`;
const STATE_HASH = `0x${'33'.repeat(32)}`;
const ACK_HASH = `0x${'41'.repeat(32)}`;
const ACK_DISPUTE_HASH = `0x${'51'.repeat(32)}`;
const ACK_PROOF_BODY_HASH = `0x${'52'.repeat(32)}`;
const PROPOSAL_HANKO = `0x${'61'.repeat(5)}`;
const PROPOSAL_DISPUTE_HANKO = `0x${'62'.repeat(6)}`;
const PROPOSAL_DISPUTE_HASH = `0x${'63'.repeat(32)}`;
const PROPOSAL_PROOF_BODY_HASH = `0x${'64'.repeat(32)}`;
const ACK_HANKO = `0x${'71'.repeat(7)}`;

const frame = (): AccountFrame => ({
  height: 7,
  timestamp: 1_700_000_000_123,
  jHeight: 606,
  accountTxs: [{ type: 'add_delta', data: { tokenId: 93 } }],
  prevFrameHash: PREVIOUS_HASH,
  accountStateRoot: STATE_ROOT,
  stateHash: STATE_HASH,
});

const peerBase = () => ({
  fromEntityId: PEER,
  toEntityId: OWNER,
  domain: { chainId: 31_337, depositoryAddress: DEPOSITORY },
  disputeConfig: { leftResponseSeconds: 17, rightResponseSeconds: 19 },
});

const account = (): AccountReplica => ({
  proofHeader: { fromEntity: OWNER, toEntity: PEER },
} as AccountReplica);

const wireBytes = (value: string): Uint8Array =>
  Uint8Array.from(Buffer.from(value.slice(2), 'hex'));

const build = (inputs: readonly AccountInput[]) => {
  beginAuthorityFrame('peer-wire');
  noteAuthorityEntityClock('peer-wire', OWNER, 'enforce', 1_700_000_000_999, 707);
  for (const input of inputs) {
    const recorded = noteRawAccountInput('peer-wire', account(), input);
    noteAuthorityAccountInputResult(recorded, { ok: true, events: [] });
  }
  return buildAuthorityWave('peer-wire');
};

const onlyOperation = (input: AccountInput): unknown[] => {
  const wave = build([input]);
  if (wave.kind !== 'wave') throw new Error(`TEST_WAVE_REQUIRED:${wave.kind}`);
  const operation = wave.entities[0]?.ops[0];
  if (!Array.isArray(operation)) throw new Error('TEST_OPERATION_REQUIRED');
  return operation;
};

describe('authority canonical Account input wire', () => {
  beforeEach(() => {
    process.env['XLN_RSCORE_AUTHORITY_RECORD'] = '1';
    resetAuthorityRecordForTests();
  });

  afterEach(() => {
    delete process.env['XLN_RSCORE_AUTHORITY_RECORD'];
    resetAuthorityRecordForTests();
  });

  test('AckFrame golden keeps every sentinel in one ACK-before-proposal operation', () => {
    const input: AccountInput = {
      ...peerBase(),
      kind: 'ack_frame',
      watchSeed: WATCH_SEED,
      ack: {
        height: 6,
        frameHash: ACK_HASH,
        disputeHanko: {
          hash: ACK_DISPUTE_HASH,
          proofBodyHash: ACK_PROOF_BODY_HASH,
          proofNonce: 53,
          proposerIsLeft: true,
        },
      },
      proposal: {
        frame: frame(),
        frameHanko: PROPOSAL_HANKO,
        disputeHanko: {
          hanko: PROPOSAL_DISPUTE_HANKO,
          hash: PROPOSAL_DISPUTE_HASH,
          proofBodyHash: PROPOSAL_PROOF_BODY_HASH,
          proofNonce: 65,
          proposerIsLeft: false,
        },
      },
    };

    const wave = build([input]);
    if (wave.kind !== 'wave') throw new Error(`TEST_WAVE_REQUIRED:${wave.kind}`);
    expect(wave.inputs).toEqual([{
      operationIndex: 0,
      arrivalIndex: 0,
      ownerEntityId: OWNER,
      accountId: PEER,
      kind: 'ack_frame',
    }]);
    expect(wave.entities[0]?.operations).toEqual([{
      operationIndex: 0,
      arrivalIndex: 0,
      accountId: PEER,
      resultKind: 'applied',
      expectedVerdict: {
        kind: 'input',
        outcome: 'applied',
        committedFrames: [],
        responseAckHanko: null,
        events: [],
      },
    }]);
    expect(wave.entities[0]?.ops).toEqual([[
      1,
      [
        0,
        wireBytes(PEER),
        [
          wireBytes(PEER),
          wireBytes(OWNER),
          [31_337, wireBytes(DEPOSITORY)],
          [17, 19],
          wireBytes(WATCH_SEED),
          [
            0,
            [
              6,
              wireBytes(ACK_HASH),
              null,
              [
                null,
                wireBytes(ACK_DISPUTE_HASH),
                wireBytes(ACK_PROOF_BODY_HASH),
                53,
                true,
              ],
            ],
            [
              [
                7,
                1_700_000_000_123,
                606,
                [[3, 93]],
                PREVIOUS_HASH,
                wireBytes(STATE_ROOT),
                wireBytes(STATE_HASH),
              ],
              wireBytes(PROPOSAL_HANKO),
              [
                wireBytes(PROPOSAL_DISPUTE_HANKO),
                wireBytes(PROPOSAL_DISPUTE_HASH),
                wireBytes(PROPOSAL_PROOF_BODY_HASH),
                65,
                false,
              ],
            ],
          ],
        ],
        null,
        [null, null],
      ],
    ]]);
  });

  test('AckFrame and Ack preserve optional absence and presence without reconstruction', () => {
    const frameInput: AccountInput = {
      ...peerBase(),
      kind: 'ack_frame',
      proposal: { frame: frame() },
    };
    const frameEnvelope = (onlyOperation(frameInput)[1] as unknown[])[2] as unknown[];
    const frameKind = frameEnvelope[5] as unknown[];
    expect(frameEnvelope[4]).toBeNull();
    expect(frameKind[0]).toBe(0);
    expect(frameKind[1]).toBeNull();
    expect((frameKind[2] as unknown[]).slice(1)).toEqual([null, null]);

    resetAuthorityRecordForTests();
    const ackInput: AccountInput = {
      ...peerBase(),
      kind: 'ack',
      ack: { height: 6, frameHash: ACK_HASH, frameHanko: ACK_HANKO },
    };
    const ackEnvelope = (onlyOperation(ackInput)[1] as unknown[])[2] as unknown[];
    const ackKind = ackEnvelope[5] as unknown[];
    expect(ackEnvelope[4]).toBeNull();
    expect(ackKind).toEqual([1, [6, wireBytes(ACK_HASH), wireBytes(ACK_HANKO), null]]);
  });

  test('missing jHeight and fromEntityId make the whole wave ineligible', () => {
    const missingJHeight = frame();
    delete (missingJHeight as Partial<AccountFrame>).jHeight;
    const missingFrameInput: AccountInput = {
      ...peerBase(),
      kind: 'ack_frame',
      proposal: { frame: missingJHeight },
    };
    const validAck: AccountInput = {
      ...peerBase(),
      kind: 'ack',
      ack: { height: 6, frameHash: ACK_HASH },
    };
    const missingFrameWave = build([validAck, missingFrameInput]);
    expect(missingFrameWave.kind).toBe('ineligible');
    if (missingFrameWave.kind !== 'ineligible') throw new Error('TEST_INELIGIBLE_REQUIRED');
    expect(missingFrameWave.reason).toContain('missing=jHeight');

    resetAuthorityRecordForTests();
    const missingFrom: AccountInput = {
      ...peerBase(),
      kind: 'ack',
      ack: { height: 6, frameHash: ACK_HASH },
    };
    delete (missingFrom as Partial<AccountInput>).fromEntityId;
    const missingFromWave = build([missingFrom]);
    expect(missingFromWave.kind).toBe('ineligible');
    if (missingFromWave.kind !== 'ineligible') throw new Error('TEST_INELIGIBLE_REQUIRED');
    expect(missingFromWave.reason).toContain('RSCORE_AUTHORITY_ACCOUNT_INPUT_FROM_ENTITY_ID');
  });

  test('an unsupported Account input variant fails the whole wave', () => {
    const dispute: AccountInput = {
      ...peerBase(),
      kind: 'dispute',
      disputeHanko: {
        hanko: PROPOSAL_DISPUTE_HANKO,
        hash: PROPOSAL_DISPUTE_HASH,
        proofBodyHash: PROPOSAL_PROOF_BODY_HASH,
        proofNonce: 65,
        proposerIsLeft: false,
      },
    };
    expect(build([dispute])).toEqual({ kind: 'ineligible', reason: 'input:dispute' });
  });
});
