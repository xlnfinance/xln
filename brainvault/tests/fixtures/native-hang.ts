#!/usr/bin/env bun

process.stderr.write('BVP1 1\n');
for await (const _chunk of Bun.stdin.stream()) {
  // Drain the private native wire input before simulating a stuck derivation.
}
await new Promise<never>(() => {});
