#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import {
  buildFrozenTree,
  collectFrozenCore,
  createFrozenManifest,
  freezeFile,
  hashFrozenFile,
  readFrozenManifest,
  renderFrozenTree,
  unfreezeFile,
} from './frozen-core/core.ts';
import type { FrozenApproval } from './frozen-core/types.ts';

const root = process.cwd();
const manifestPath = resolve(root, 'frozen-core.json');
const command = process.argv[2] || 'check';
const release = readFileSync(resolve(root, 'VERSION'), 'utf8').trim();

function writeManifest(value: unknown): void {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(value, null, 2)}\n`);
}

if (command === 'init') {
  // init is genesis-only. Re-running it after a mutation would bless the changed bytes with
  // no owner approval record, so an existing manifest is an unconditional hard stop.
  if (existsSync(manifestPath)) throw new Error(`FROZEN_CORE_ALREADY_INITIALIZED:${manifestPath}`);
  const paths = process.argv.slice(3).filter((arg) => !arg.startsWith('--'));
  const reason = process.argv.find((arg) => arg.startsWith('--reason='))?.slice('--reason='.length) || 'Explicitly frozen by project owner.';
  if (!paths.length) throw new Error('Usage: bun tools/frozen-core.ts init <file> [...] --reason=<reason>');
  writeManifest(createFrozenManifest(root, paths, release, reason));
  console.log(`Frozen core initialized: ${paths.length} file(s)`);
  process.exit(0);
}

const manifest = readFrozenManifest(manifestPath);

if (command === 'check' || command === 'tree') {
  const snapshot = collectFrozenCore(root, manifest, release);
  console.log(renderFrozenTree(snapshot));
  if (snapshot.mutableDependencies.length) {
    console.warn(`FROZEN_CORE_DEPENDENCY_WARNING: ${snapshot.mutableDependencies.length} mutable imports`);
  }
  process.exit(0);
}

if (command === 'add' || command === 'remove') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('FROZEN_CORE_POLICY_CHANGE_REQUIRES_INTERACTIVE_TTY');
  const explicitPaths = process.argv.slice(3).filter((arg) => arg !== '--' && !arg.startsWith('--reason='));
  const paths = explicitPaths.length > 0
    ? explicitPaths
    : command === 'remove' && manifest.files.length === 1
      ? [manifest.files[0]!.path]
      : [];
  if (!paths.length) {
    throw new Error(`Usage: bun tools/frozen-core.ts ${command} <file> [...] [--reason=<reason>]`);
  }
  const defaultReason = command === 'add'
    ? 'Frozen by project owner.'
    : 'Temporarily unfrozen by project owner.';
  const reason = process.argv.find((arg) => arg.startsWith('--reason='))?.slice('--reason='.length).trim() || defaultReason;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const path of paths) {
      const verb = command === 'add' ? 'FREEZE' : 'UNFREEZE';
      const confirmation = paths.length === 1 ? verb : `${verb} ${path}`;
      console.log(`\n${command === 'add' ? 'Freeze' : 'Unfreeze'} ${path}\nreason ${reason}`);
      while ((await prompt.question(`Type ${confirmation}: `)).trim() !== confirmation) {
        console.error(`Not confirmed. Type exactly: ${confirmation}`);
      }
      const changedAt = new Date().toISOString();
      if (command === 'add') freezeFile(root, manifest, path, release, reason, changedAt);
      else unfreezeFile(root, manifest, path, release, reason, changedAt);
    }
  } finally {
    prompt.close();
  }
  writeManifest(manifest);
  console.log(`Frozen core policy updated for release ${release}: ${paths.length} file(s)`);
  process.exit(0);
}

if (command !== 'approve') throw new Error(`Unknown frozen-core command: ${command}`);
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('FROZEN_CORE_APPROVAL_REQUIRES_INTERACTIVE_TTY');

const changed = manifest.files.map((expected) => ({ expected, current: hashFrozenFile(root, expected.path) }))
  .filter(({ expected, current }) => expected.leafHash !== current.leafHash);
if (!changed.length) throw new Error('FROZEN_CORE_NO_CHANGES_TO_APPROVE');

const prompt = createInterface({ input: process.stdin, output: process.stdout });
try {
  for (const change of changed) {
    console.log(`\n${change.expected.path}\nold ${change.expected.contentHash}\nnew ${change.current.contentHash}`);
    const fullConfirmation = `APPROVE ${change.expected.path}`;
    const acceptedConfirmations = changed.length === 1
      ? new Set(['APPROVE', fullConfirmation])
      : new Set([fullConfirmation]);
    const confirmationPrompt = changed.length === 1
      ? 'Type APPROVE: '
      : `Type ${fullConfirmation}: `;

    while (true) {
      const confirmation = (await prompt.question(confirmationPrompt)).trim();
      if (acceptedConfirmations.has(confirmation)) break;
      console.error(
        changed.length === 1
          ? 'Not approved. Type exactly: APPROVE'
          : `Not approved. Type exactly: ${fullConfirmation}`,
      );
    }

    const comment = (await prompt.question('Approval comment (optional): ')).trim();

    const approval: FrozenApproval = {
      path: change.expected.path,
      oldContentHash: change.expected.contentHash,
      newContentHash: change.current.contentHash,
      oldLeafHash: change.expected.leafHash,
      newLeafHash: change.current.leafHash,
      release,
      approvedAt: new Date().toISOString(),
      comment,
    };
    Object.assign(change.expected, change.current);
    manifest.approvals.push(approval);
  }
} finally {
  prompt.close();
}
manifest.rootHash = buildFrozenTree(manifest.files).hash;
writeManifest(manifest);
console.log(`Frozen core approved for release ${release}: ${changed.length} file(s)`);
