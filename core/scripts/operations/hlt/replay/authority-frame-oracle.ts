import { decodeAccountFrame } from '../../../../account/validation/frame-validation';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../../protocol/boundary-validation';
import type { AccountFrame } from '../../../../types/account';

export type HltCertifiedEntityFrame = Readonly<{
  runtimeHeight: number;
  entityId: string;
  entityHeight: number;
  frameHash: string;
  stateRoot: string;
  authorityRoot: string;
  /** Explicit Account-forest root at this exact Runtime height. */
  accountsRoot: string;
  /** Cold canonical section commitments for immediate first-divergence output. */
  sections: readonly Readonly<{ field: string; digest: string }>[];
}>;

export type HltCertifiedAccountFrame = Readonly<{
  runtimeHeight: number;
  entityId: string;
  counterpartyId: string;
  source: 'ackCommit' | 'peerCommit';
  frame: AccountFrame;
}>;

export type HltAuthorityFrameOracle = Readonly<{
  entityFrames: readonly HltCertifiedEntityFrame[];
  accountFrames: readonly HltCertifiedAccountFrame[];
}>;

const text = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim().toLowerCase();
};

const decodeEntityFrame = (value: unknown, index: number): HltCertifiedEntityFrame => {
  const row = requireBoundaryRecord(value, `HLT_AUTHORITY_ENTITY_FRAME_INVALID:${index}`);
  requireExactBoundaryKeys(
    row,
    ['runtimeHeight', 'entityId', 'entityHeight', 'frameHash', 'stateRoot', 'authorityRoot', 'accountsRoot', 'sections'],
    [],
    `HLT_AUTHORITY_ENTITY_FRAME_FIELDS_INVALID:${index}`,
  );
  if (!Array.isArray(row['sections'])) {
    throw new Error(`HLT_AUTHORITY_ENTITY_SECTIONS_INVALID:${index}`);
  }
  return {
    runtimeHeight: requireBoundaryInteger(row['runtimeHeight'], `HLT_AUTHORITY_ENTITY_RUNTIME_HEIGHT_INVALID:${index}`),
    entityId: text(row['entityId'], `HLT_AUTHORITY_ENTITY_ID_INVALID:${index}`),
    entityHeight: requireBoundaryInteger(row['entityHeight'], `HLT_AUTHORITY_ENTITY_HEIGHT_INVALID:${index}`),
    frameHash: text(row['frameHash'], `HLT_AUTHORITY_ENTITY_HASH_INVALID:${index}`),
    stateRoot: text(row['stateRoot'], `HLT_AUTHORITY_ENTITY_STATE_ROOT_INVALID:${index}`),
    authorityRoot: text(row['authorityRoot'], `HLT_AUTHORITY_ENTITY_AUTHORITY_ROOT_INVALID:${index}`),
    accountsRoot: text(row['accountsRoot'], `HLT_AUTHORITY_ENTITY_ACCOUNTS_ROOT_INVALID:${index}`),
    sections: row['sections'].map((value, sectionIndex) => {
      const section = requireBoundaryRecord(
        value,
        `HLT_AUTHORITY_ENTITY_SECTION_INVALID:${index}:${sectionIndex}`,
      );
      requireExactBoundaryKeys(
        section,
        ['field', 'digest'],
        [],
        `HLT_AUTHORITY_ENTITY_SECTION_FIELDS_INVALID:${index}:${sectionIndex}`,
      );
      const field = String(section['field'] ?? '').trim();
      if (!field) {
        throw new Error(`HLT_AUTHORITY_ENTITY_SECTION_FIELD_INVALID:${index}:${sectionIndex}`);
      }
      return {
        field,
        digest: text(section['digest'], `HLT_AUTHORITY_ENTITY_SECTION_DIGEST_INVALID:${index}:${sectionIndex}`),
      };
    }),
  };
};

const decodeCertifiedAccountFrame = (value: unknown, index: number): HltCertifiedAccountFrame => {
  const row = requireBoundaryRecord(value, `HLT_AUTHORITY_ACCOUNT_FRAME_INVALID:${index}`);
  requireExactBoundaryKeys(
    row,
    ['runtimeHeight', 'entityId', 'counterpartyId', 'source', 'frame'],
    [],
    `HLT_AUTHORITY_ACCOUNT_FRAME_FIELDS_INVALID:${index}`,
  );
  if (row['source'] !== 'ackCommit' && row['source'] !== 'peerCommit') {
    throw new Error(`HLT_AUTHORITY_ACCOUNT_FRAME_SOURCE_INVALID:${index}`);
  }
  return {
    runtimeHeight: requireBoundaryInteger(row['runtimeHeight'], `HLT_AUTHORITY_ACCOUNT_RUNTIME_HEIGHT_INVALID:${index}`),
    entityId: text(row['entityId'], `HLT_AUTHORITY_ACCOUNT_ENTITY_ID_INVALID:${index}`),
    counterpartyId: text(row['counterpartyId'], `HLT_AUTHORITY_ACCOUNT_COUNTERPARTY_INVALID:${index}`),
    source: row['source'],
    frame: decodeAccountFrame(row['frame'], `HLT_AUTHORITY_ACCOUNT_FRAME:${index}`),
  };
};

export const decodeHltAuthorityFrameOracle = (value: unknown): HltAuthorityFrameOracle => {
  const root = requireBoundaryRecord(value, 'HLT_AUTHORITY_FRAME_ORACLE_INVALID');
  requireExactBoundaryKeys(root, ['entityFrames', 'accountFrames'], [], 'HLT_AUTHORITY_FRAME_ORACLE_FIELDS_INVALID');
  if (!Array.isArray(root['entityFrames']) || !Array.isArray(root['accountFrames'])) {
    throw new Error('HLT_AUTHORITY_FRAME_ORACLE_ARRAYS_REQUIRED');
  }
  return {
    entityFrames: root['entityFrames'].map(decodeEntityFrame),
    accountFrames: root['accountFrames'].map(decodeCertifiedAccountFrame),
  };
};
