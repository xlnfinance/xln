#!/usr/bin/env bun

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { ethers } from 'ethers';

import {
  createFoundationReleaseBoard,
  verifyReleaseAttestation,
  type ReleaseAttestation,
} from '../frontend/src/lib/releases/release-signature.ts';
import type { FoundationReleaseKeys } from './release-snapshot/sign.ts';
import type { ReleaseSnapshot } from './release-snapshot/types.ts';

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

if (command === 'verify') {
  const snapshotPath = value('snapshot', `docs/releases/data/${readFileSync('VERSION', 'utf8').trim()}.json`);
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as ReleaseSnapshot;
  if (!snapshot.attestation) throw new Error(`RELEASE_ATTESTATION_MISSING:${snapshotPath}`);
  const valid = verifyReleaseAttestation(snapshot.attestation as ReleaseAttestation);
  if (!valid) throw new Error(`RELEASE_ATTESTATION_INVALID:${snapshotPath}`);
  console.log(`Foundation Hanko verified: ${snapshot.release.version} ${snapshot.attestation.envelopeHash}`);
  process.exit(0);
}

throw new Error('Usage: bun tools/foundation-release.ts <init|verify> [--board=path] [--keys=path] [--snapshot=path]');
