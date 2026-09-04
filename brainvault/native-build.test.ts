import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(`BRAINVAULT_NATIVE_BUILD_HOST_UNSUPPORTED:${process.platform}:${process.arch}`);
}

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

test('shipped Apple Silicon artifacts target the M1-era macOS baseline', () => {
  for (const artifact of [
    'brainvault-argon2',
    'brainvault-argon2-m3',
    'brainvault-argon2-metal',
    'brainvault-argon2-opencl',
    'brainvault-argon2-rust',
    'brainvault-argon2-rust-m3',
    'brainvault-argon2-rust-no-wipe',
    'brainvault-argon2-rust-no-wipe-m3',
  ]) {
    const inspected = Bun.spawnSync({
      cmd: ['vtool', '-show-build', `${import.meta.dir}/prebuilds/darwin-arm64/${artifact}`],
      stderr: 'pipe', stdout: 'pipe',
    });
    expect(inspected.exitCode).toBe(0);
    expect(inspected.stdout.toString()).toMatch(/minos 11\.0(?:\s|$)/);
  }
  const metalStrings = Bun.spawnSync({
    cmd: ['strings', `${import.meta.dir}/prebuilds/darwin-arm64/argon2.metallib`],
    stderr: 'pipe', stdout: 'pipe',
  });
  expect(metalStrings.exitCode).toBe(0);
  expect(metalStrings.stdout.toString()).toContain('apple-macosx11.0.0');
});

test('locked native release builds are byte-reproducible', () => {
  const temp = mkdtempSync(join(tmpdir(), 'brainvault-repro-'));
  try {
    const cRoot = `${import.meta.dir}/experimental/argon2-c`;
    const sources = [
      'brainvault_argon2.c', 'vendor/argon2/src/argon2.c', 'vendor/argon2/src/core.c',
      'vendor/argon2/src/blake2/blake2b.c', 'vendor/argon2/src/thread.c',
      'vendor/argon2/src/encoding.c', 'vendor/argon2/src/opt.c',
    ];
    const compileC = (output: string, cpu: 'apple-m1' | 'apple-m3') => Bun.spawnSync({
      cmd: [
        'clang', '-std=c11', '-O3', '-flto', `-mcpu=${cpu}`, '-mmacosx-version-min=11.0', '-pthread',
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
    expect(compileC(m3First, 'apple-m3').exitCode).toBe(0);
    expect(compileC(m3Second, 'apple-m3').exitCode).toBe(0);
    normalize(m3First);
    normalize(m3Second);
    expect(sha256(m3First)).toBe(sha256(m3Second));
    expect(sha256(m3First)).toBe(sha256(`${import.meta.dir}/prebuilds/darwin-arm64/brainvault-argon2-m3`));

    const rustRoot = `${import.meta.dir}/experimental/argon2-rust`;
    const cargoHome = join(temp, 'empty-cargo-home');
    mkdirSync(cargoHome);
    const buildRust = (target: string, noWipe: boolean, cpu: 'apple-m1' | 'apple-m3') => Bun.spawnSync({
      cmd: [
        'cargo', 'build', '--offline', '--release', '--locked',
        ...(noWipe ? ['--no-default-features'] : []), '--target-dir', target,
      ],
      cwd: rustRoot,
      env: {
        ...process.env,
        CARGO_HOME: cargoHome,
        MACOSX_DEPLOYMENT_TARGET: '11.0',
        RUSTFLAGS: `-C target-cpu=${cpu} -C link-arg=-mmacosx-version-min=11.0`,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    for (const cpu of ['apple-m1', 'apple-m3'] as const) {
      for (const noWipe of [false, true]) {
        const variant = `${cpu === 'apple-m3' ? 'm3' : 'm1'}${noWipe ? '-no-wipe' : ''}`;
        const first = join(temp, `rust-${variant}-1`);
        const second = join(temp, `rust-${variant}-2`);
        expect(buildRust(first, noWipe, cpu).exitCode).toBe(0);
        expect(buildRust(second, noWipe, cpu).exitCode).toBe(0);
        const prebuildName = `brainvault-argon2-rust${noWipe ? '-no-wipe' : ''}${cpu === 'apple-m3' ? '-m3' : ''}`;
        const firstBinary = join(first, `release/${prebuildName}`);
        const secondBinary = join(second, `release/${prebuildName}`);
        renameSync(join(first, 'release/brainvault-argon2-rust'), firstBinary);
        renameSync(join(second, 'release/brainvault-argon2-rust'), secondBinary);
        normalize(firstBinary);
        normalize(secondBinary);
        expect(sha256(firstBinary)).toBe(sha256(secondBinary));
        expect(sha256(firstBinary)).toBe(sha256(`${import.meta.dir}/prebuilds/darwin-arm64/${prebuildName}`));
      }
    }

    const metalRoot = `${import.meta.dir}/experimental/argon2-metal`;
    const metalSources = [
      'brainvault_argon2_metal.m',
      '../argon2-c/vendor/argon2/src/argon2.c',
      '../argon2-c/vendor/argon2/src/core.c',
      '../argon2-c/vendor/argon2/src/blake2/blake2b.c',
      '../argon2-c/vendor/argon2/src/thread.c',
      '../argon2-c/vendor/argon2/src/encoding.c',
      '../argon2-c/vendor/argon2/src/opt.c',
    ];
    const compileMetalHost = (output: string) => Bun.spawnSync({
      cmd: [
        'clang', '-std=c11', '-O3', '-flto', '-mcpu=apple-m1', '-mmacosx-version-min=11.0', '-fobjc-arc',
        '-D_DARWIN_C_SOURCE', '-D__SSE2__', '-I../argon2-c/compat',
        '-I../argon2-c/vendor/sse2neon', '-I../argon2-c/vendor/argon2/include',
        '-I../argon2-c/vendor/argon2/src', ...metalSources,
        '-framework', 'Foundation', '-framework', 'Metal', '-pthread', '-o', output,
      ],
      cwd: metalRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const metalHost1 = join(temp, 'c1/brainvault-argon2-metal');
    const metalHost2 = join(temp, 'c2/brainvault-argon2-metal');
    expect(compileMetalHost(metalHost1).exitCode).toBe(0);
    expect(compileMetalHost(metalHost2).exitCode).toBe(0);
    normalize(metalHost1);
    normalize(metalHost2);
    expect(sha256(metalHost1)).toBe(sha256(metalHost2));
    expect(sha256(metalHost1)).toBe(sha256(`${import.meta.dir}/prebuilds/darwin-arm64/brainvault-argon2-metal`));

    const compileMetalLibrary = (air: string, library: string) => {
      const compile = Bun.spawnSync({
        cmd: ['xcrun', 'metal', '-O3', '-mmacosx-version-min=11.0', '-c', 'argon2.metal', '-o', air],
        cwd: metalRoot, stderr: 'pipe', stdout: 'pipe',
      });
      if (compile.exitCode !== 0) return compile;
      return Bun.spawnSync({
        cmd: ['xcrun', 'metallib', air, '-o', library],
        cwd: metalRoot, stderr: 'pipe', stdout: 'pipe',
      });
    };
    const metalAir1 = join(temp, 'argon2-1.air');
    const metalAir2 = join(temp, 'argon2-2.air');
    const metalLib1 = join(temp, 'argon2-1.metallib');
    const metalLib2 = join(temp, 'argon2-2.metallib');
    expect(compileMetalLibrary(metalAir1, metalLib1).exitCode).toBe(0);
    expect(compileMetalLibrary(metalAir2, metalLib2).exitCode).toBe(0);
    expect(sha256(metalLib1)).toBe(sha256(metalLib2));
    expect(sha256(metalLib1)).toBe(sha256(`${import.meta.dir}/prebuilds/darwin-arm64/argon2.metallib`));

    const openclRoot = `${import.meta.dir}/experimental/argon2-opencl`;
    const openclSources = [
      'brainvault_argon2_opencl.cpp',
      'lib/argon2-gpu-common/argon2params.cpp',
      'lib/argon2-gpu-common/blake2b.cpp',
      'lib/argon2-opencl/device.cpp',
      'lib/argon2-opencl/globalcontext.cpp',
      'lib/argon2-opencl/kernelloader.cpp',
      'lib/argon2-opencl/kernelrunner.cpp',
      'lib/argon2-opencl/processingunit.cpp',
      'lib/argon2-opencl/programcontext.cpp',
    ];
    const compileOpencl = (output: string) => Bun.spawnSync({
      cmd: [
        'clang++', '-Iinclude', '-Iinclude/argon2-gpu-common', '-Iinclude/argon2-opencl',
        '-Ilib/argon2-gpu-common', '-Ilib/argon2-opencl', '-O3', '-DNDEBUG',
        '-mmacosx-version-min=11.0',
        '-std=c++11', ...openclSources, '-framework', 'OpenCL', '-o', output,
      ],
      cwd: openclRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const opencl1 = join(temp, 'c1/brainvault-argon2-opencl');
    const opencl2 = join(temp, 'c2/brainvault-argon2-opencl');
    expect(compileOpencl(opencl1).exitCode).toBe(0);
    expect(compileOpencl(opencl2).exitCode).toBe(0);
    normalize(opencl1);
    normalize(opencl2);
    expect(sha256(opencl1)).toBe(sha256(opencl2));
    expect(sha256(opencl1)).toBe(sha256(`${import.meta.dir}/prebuilds/darwin-arm64/brainvault-argon2-opencl`));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 60_000);
