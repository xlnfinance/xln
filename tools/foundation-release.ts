#!/usr/bin/env bun

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { ethers } from 'ethers';

import {
  createFoundationReleaseBoard,
  isCanonicalFoundationBoard,
  verifyReleaseSnapshot,
  type FoundationReleaseBoard,
} from '../frontend/src/lib/releases/release-signature.ts';
import type { FoundationReleaseKeys } from './release-snapshot/sign.ts';
import type { ReleaseSnapshot } from './release-snapshot/types.ts';
import {
  assertReleaseSourceContainedInPublishedRef,
  assertReleaseTagBindsSource,
} from './release-snapshot/source-policy.ts';

const command = process.argv[2];
const value = (name: string, fallback: string): string =>
  resolve(process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback);
const boardPath = value('board', 'foundation-release-board.json');
const keysPath = value('keys', `${homedir()}/.config/xln/foundation-release-keys.json`);

if (command === 'init') {
  if (existsSync(boardPath) || existsSync(keysPath)) throw new Error('FOUNDATION_RELEASE_KEYS_ALREADY_EXIST');
  const privateKeys = Array.from({ length: 3 }, () => ethers.hexlify(randomBytes(32)));
  const addresses = privateKeys.map((privateKey) => ethers.computeAddress(new ethers.SigningKey(privateKey).publicKey));
  const board = createFoundationReleaseBoard(addresses, 2);
  const keys: FoundationReleaseKeys = { schemaVersion: 1, boardHash: board.boardHash, privateKeys };
  mkdirSync(dirname(keysPath), { recursive: true, mode: 0o700 });
  writeFileSync(keysPath, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  chmodSync(keysPath, 0o600);
  writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`);
  console.log(`Foundation release board initialized: ${board.entityId}`);
  console.log(`Private keys stored outside repository: ${keysPath}`);
  process.exit(0);
}

if (command === 'verify' || command === 'publish-check') {
  const snapshotPath = value('snapshot', `docs/releases/data/${readFileSync('VERSION', 'utf8').trim()}.json`);
  const board = JSON.parse(readFileSync(boardPath, 'utf8')) as FoundationReleaseBoard;
  // --board selects the expected copy, not a replacement trust root. Accepting any supplied
  // board would restore the self-signed-board attack this verifier exists to prevent.
  if (!isCanonicalFoundationBoard(board)) throw new Error(`FOUNDATION_RELEASE_BOARD_NOT_TRUSTED:${boardPath}`);
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as ReleaseSnapshot;
  const valid = verifyReleaseSnapshot(snapshot, board);
  if (!snapshot.attestation) {
    if (!valid) throw new Error(`RELEASE_ATTESTATION_MISSING:${snapshotPath}`);
    if (command === 'publish-check') {
      assertReleaseSourceContainedInPublishedRef(process.cwd(), snapshot.release.sourceCommit);
      assertReleaseTagBindsSource(process.cwd(), snapshot.release.version, snapshot.release.sourceCommit);
      console.log(`Release tag binds source: v${snapshot.release.version} ${snapshot.release.sourceCommit}`);
    }
    console.log(`Historical unsigned release: ${snapshot.release.version}`);
    process.exit(0);
  }
  if (!valid) throw new Error(`RELEASE_ATTESTATION_INVALID:${snapshotPath}`);
  if (command === 'publish-check') {
    assertReleaseSourceContainedInPublishedRef(process.cwd(), snapshot.release.sourceCommit);
    assertReleaseTagBindsSource(process.cwd(), snapshot.release.version, snapshot.release.sourceCommit);
    console.log(`Release tag binds source: v${snapshot.release.version} ${snapshot.release.sourceCommit}`);
  }
  console.log(`Foundation Hanko verified: ${snapshot.release.version} ${snapshot.attestation.envelopeHash}`);
  process.exit(0);
}

throw new Error('Usage: bun tools/foundation-release.ts <init|verify|publish-check> [--board=path] [--keys=path] [--snapshot=path]');
