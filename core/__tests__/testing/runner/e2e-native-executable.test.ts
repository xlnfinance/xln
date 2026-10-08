import { expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, openSync, closeSync, readSync, writeSync, statSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureE2ENativeExecutable, assertE2ENativeExecutableStable } from '../../../scripts/e2e/harness/e2e-isolated-runtime';
import { buildQaCandidateIdentity } from '../../../qa/candidate';

test('native provenance binds actual executable bytes and rejects same-mtime replacement', () => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-native-provenance-'));
  const path = join(directory, 'native-executable');
  try {
    copyFileSync(process.execPath, path);
    const before = captureE2ENativeExecutable({ XLN_HLT_ENGINE: 'rust', XLN_RSCORE_BINARY: path });
    expect(before?.path).toBe(path);
    expect(before?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertE2ENativeExecutableStable(before)).not.toThrow();
    const metadata = statSync(path);
    const fd = openSync(path, 'r+');
    try {
      const byte = Buffer.alloc(1);
      readSync(fd, byte, 0, 1, metadata.size - 1);
      byte[0] = byte.readUInt8(0) ^ 1;
      writeSync(fd, byte, 0, 1, metadata.size - 1);
    } finally { closeSync(fd); }
    utimesSync(path, metadata.atime, metadata.mtime);
    expect(() => assertE2ENativeExecutableStable(before)).toThrow('E2E_NATIVE_EXECUTABLE_DRIFT');
    const after = captureE2ENativeExecutable({ XLN_HLT_ENGINE: 'rust', XLN_RSCORE_BINARY: path });
    const candidate = (nativeExecutable: unknown) => buildQaCandidateIdentity({ gitHead: '1'.repeat(40), codeHash: '2'.repeat(64), gateConfig: { nativeExecutable } });
    expect(candidate(before).candidateId).not.toBe(candidate(after).candidateId);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('TS-only run has no native executable dependency; selected missing native path fails', () => {
  expect(captureE2ENativeExecutable({ XLN_HLT_ENGINE: 'ts', XLN_RSCORE_BINARY: '/missing/native' })).toBeNull();
  expect(() => captureE2ENativeExecutable({ XLN_HLT_ENGINE: 'rust', XLN_RSCORE_BINARY: '/missing/native' })).toThrow();
});
