import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function sha256(path: string): string {
  return new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex');
}

function normalize(path: string): void {
  const unsigned = Bun.spawnSync({
    cmd: ['codesign', '--remove-signature', path],
    stderr: 'pipe',
    stdout: 'pipe',
  });
  expect(unsigned.exitCode).toBe(0);
  const run = Bun.spawnSync({
    cmd: ['bun', `${import.meta.dir}/experimental/normalize-macho.ts`, path],
    stderr: 'pipe',
    stdout: 'pipe',
  });
  expect(run.exitCode).toBe(0);
  const signed = Bun.spawnSync({
    cmd: ['codesign', '--force', '--sign', '-', '--timestamp=none', path],
    stderr: 'pipe',
    stdout: 'pipe',
  });
  expect(signed.exitCode).toBe(0);
}

test('locked native release builds are byte-reproducible', () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  const temp = mkdtempSync(join(tmpdir(), 'brainvault-repro-'));
  try {
    const cRoot = `${import.meta.dir}/experimental/argon2-c`;
    const sources = [
      'brainvault_argon2.c', 'vendor/argon2/src/argon2.c', 'vendor/argon2/src/core.c',
      'vendor/argon2/src/blake2/blake2b.c', 'vendor/argon2/src/thread.c',
      'vendor/argon2/src/encoding.c', 'vendor/argon2/src/opt.c',
    ];
    const compileC = (output: string, cpu: 'apple-m1' | 'native') => Bun.spawnSync({
      cmd: [
        'clang', '-std=c11', '-O3', '-flto', `-mcpu=${cpu}`, '-pthread',
        '-D_DARWIN_C_SOURCE', '-D__SSE2__', '-Icompat', '-Ivendor/sse2neon',
        '-Ivendor/argon2/include', '-Ivendor/argon2/src', ...sources, '-o', output,
      ],
      cwd: cRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    mkdirSync(join(temp, 'c1'));
    mkdirSync(join(temp, 'c2'));
    const c1 = join(temp, 'c1/brainvault-argon2');
    const c2 = join(temp, 'c2/brainvault-argon2');
    expect(compileC(c1, 'apple-m1').exitCode).toBe(0);
    expect(compileC(c2, 'apple-m1').exitCode).toBe(0);
    normalize(c1);
    normalize(c2);
    expect(sha256(c1)).toBe(sha256(c2));
    expect(sha256(c1)).toBe(sha256(`${import.meta.dir}/prebuilds/darwin-arm64/brainvault-argon2`));

    const m3First = join(temp, 'c1/brainvault-argon2-m3');
    const m3Second = join(temp, 'c2/brainvault-argon2-m3');
    expect(compileC(m3First, 'native').exitCode).toBe(0);
    expect(compileC(m3Second, 'native').exitCode).toBe(0);
    normalize(m3First);
    normalize(m3Second);
    expect(sha256(m3First)).toBe(sha256(m3Second));
    expect(sha256(m3First)).toBe(sha256(`${import.meta.dir}/prebuilds/darwin-arm64/brainvault-argon2-m3`));

    const rustRoot = `${import.meta.dir}/experimental/argon2-rust`;
    const buildRust = (target: string, noWipe: boolean) => Bun.spawnSync({
      cmd: [
        'cargo', 'build', '--release', '--locked',
        ...(noWipe ? ['--no-default-features'] : []), '--target-dir', target,
      ],
      cwd: rustRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    for (const noWipe of [false, true]) {
      const first = join(temp, noWipe ? 'rust-no-wipe-1' : 'rust-1');
      const second = join(temp, noWipe ? 'rust-no-wipe-2' : 'rust-2');
      expect(buildRust(first, noWipe).exitCode).toBe(0);
      expect(buildRust(second, noWipe).exitCode).toBe(0);
      const finalName = `brainvault-argon2-rust${noWipe ? '-no-wipe' : ''}`;
      const firstBinary = join(first, `release/${finalName}`);
      const secondBinary = join(second, `release/${finalName}`);
      if (noWipe) {
        renameSync(join(first, 'release/brainvault-argon2-rust'), firstBinary);
        renameSync(join(second, 'release/brainvault-argon2-rust'), secondBinary);
      }
      normalize(firstBinary);
      normalize(secondBinary);
      expect(sha256(firstBinary)).toBe(sha256(secondBinary));
      expect(sha256(firstBinary)).toBe(sha256(
        `${import.meta.dir}/prebuilds/darwin-arm64/brainvault-argon2-rust${noWipe ? '-no-wipe' : ''}`,
      ));
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 28_000);
