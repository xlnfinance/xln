import { readFileSync } from 'node:fs';

import {
  signReleaseEnvelope,
  verifyReleaseAttestation,
  type FoundationReleaseBoard,
} from '../../frontend/src/lib/releases/release-signature.ts';
import type { ReleaseSnapshot } from './types.ts';

export type FoundationReleaseKeys = {
  schemaVersion: 1;
  boardHash: string;
  privateKeys: string[];
};

export function signReleaseSnapshot(snapshot: ReleaseSnapshot, boardPath: string, keysPath: string): ReleaseSnapshot {
  if (!snapshot.frozenCore) throw new Error('RELEASE_SIGNING_REQUIRES_FROZEN_CORE');
  const board = JSON.parse(readFileSync(boardPath, 'utf8')) as FoundationReleaseBoard;
  const keys = JSON.parse(readFileSync(keysPath, 'utf8')) as FoundationReleaseKeys;
  if (keys.schemaVersion !== 1 || keys.boardHash.toLowerCase() !== board.boardHash.toLowerCase()) {
    throw new Error('RELEASE_SIGNING_KEY_BOARD_MISMATCH');
  }
  snapshot.attestation = signReleaseEnvelope({
    version: snapshot.release.version,
    sourceCommit: snapshot.release.sourceCommit,
    codeSnapshotRoot: snapshot.repository.merkleRoot,
    frozenCoreRoot: snapshot.frozenCore.rootHash,
    generatedAt: snapshot.release.generatedAt,
  }, board, keys.privateKeys);
  if (!verifyReleaseAttestation(snapshot.attestation)) throw new Error('RELEASE_ATTESTATION_VERIFY_FAILED');
  return snapshot;
}
