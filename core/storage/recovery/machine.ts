import { ethers, getBytes } from 'ethers';
import {
  assertLocalEntityCryptoKeys,
  provisionEntityEncryptionKey,
} from '../../entity/auth/crypto';
import { safeStringify } from '../../protocol/serialization';
import { deriveEntityEncryptionPrivateKey } from '../../runtime/registration/entity-creation/crypto';
import type { RuntimeReplica } from '../../runtime/types';
import { canonicalizeStorageAuditValue } from '../canonical-hash';
import {
  buildStorageRuntimeMachineSnapshot,
  projectReplayVerifiableRuntimeMachine,
} from '../wal/snapshot';

export const restoreEntityKeysFromAuthoritativeSnapshot = (
  env: RuntimeReplica,
): void => {
  const retainedSeeds = env.infrastructure?.entityEncryptionSeeds;
  if (!retainedSeeds) return;
  for (const [entityId, seed] of retainedSeeds) {
    provisionEntityEncryptionKey(
      env,
      entityId,
      deriveEntityEncryptionPrivateKey(getBytes(seed), entityId),
    );
  }
};

export const restoreAndAssertLocalEntityCryptoKeys = (
  env: RuntimeReplica,
): void => {
  restoreEntityKeysFromAuthoritativeSnapshot(env);
  assertLocalEntityCryptoKeys(env);
};

const canonicalMachine = (machine: Record<string, unknown>): string =>
  safeStringify(canonicalizeStorageAuditValue(machine));

export const listRecoveryRuntimeMachineMismatchFields = (
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): string[] => {
  const fields = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const mismatches: string[] = [];
  for (const field of [...fields].sort()) {
    const expectedHas = Object.hasOwn(expected, field);
    const actualHas = Object.hasOwn(actual, field);
    if (expectedHas !== actualHas) {
      mismatches.push(field);
      continue;
    }
    if (
      canonicalMachine({ value: expected[field] }) ===
      canonicalMachine({ value: actual[field] })
    ) {
      continue;
    }
    if (field !== 'infrastructure') {
      mismatches.push(field);
      continue;
    }
    const expectedState =
      expected[field] && typeof expected[field] === 'object'
        ? expected[field] as Record<string, unknown>
        : {};
    const actualState =
      actual[field] && typeof actual[field] === 'object'
        ? actual[field] as Record<string, unknown>
        : {};
    const stateFields = new Set([
      ...Object.keys(expectedState),
      ...Object.keys(actualState),
    ]);
    for (const stateField of [...stateFields].sort()) {
      const expectedHasState = Object.hasOwn(expectedState, stateField);
      const actualHasState = Object.hasOwn(actualState, stateField);
      if (
        expectedHasState !== actualHasState ||
        canonicalMachine({ value: expectedState[stateField] }) !==
          canonicalMachine({ value: actualState[stateField] })
      ) {
        mismatches.push(`infrastructure.${stateField}`);
      }
    }
  }
  return mismatches;
};

const readMachineField = (
  machine: Record<string, unknown>,
  field: string,
): unknown => {
  if (!field.startsWith('infrastructure.')) return machine[field];
  const state = machine['infrastructure'];
  if (!state || typeof state !== 'object') return undefined;
  return (state as Record<string, unknown>)[
    field.slice('infrastructure.'.length)
  ];
};

export const assertRecoveryRuntimeMachineMatches = (
  env: RuntimeReplica,
  expectedMachine: Record<string, unknown>,
  height: number,
): void => {
  const actualMachine = projectReplayVerifiableRuntimeMachine(
    buildStorageRuntimeMachineSnapshot(env),
  );
  const expectedMachineForReplay =
    projectReplayVerifiableRuntimeMachine(expectedMachine);
  const actual = canonicalMachine(actualMachine);
  const expected = canonicalMachine(expectedMachineForReplay);
  if (actual === expected) return;

  const fields = listRecoveryRuntimeMachineMismatchFields(
    expectedMachineForReplay,
    actualMachine,
  );
  const firstField = fields[0] || 'unknown';
  const expectedValue = readMachineField(
    expectedMachineForReplay,
    firstField,
  );
  const actualValue = readMachineField(actualMachine, firstField);
  // Digests only: machine fields include infrastructure.entityEncryptionSeeds,
  // and this message reaches logs and incident journals.
  const fieldEvidence = (value: unknown) => {
    if (value === undefined) return { present: false };
    const encoded = canonicalMachine({ value });
    return { present: true, bytes: encoded.length, digest: ethers.keccak256(ethers.toUtf8Bytes(encoded)) };
  };
  const detail = canonicalMachine({
    actual: fieldEvidence(actualValue),
    expected: fieldEvidence(expectedValue),
  });
  throw new Error(
    `RECOVERY_JOURNAL_RUNTIME_MACHINE_MISMATCH:height=${height}:` +
    `fields=${fields.join(',') || 'unknown'}:` +
    `expected=${ethers.keccak256(ethers.toUtf8Bytes(expected))}:` +
    `actual=${ethers.keccak256(ethers.toUtf8Bytes(actual))}:` +
    `detail=${detail}`,
  );
};
