#!/usr/bin/env bun

const pidFile = process.env.BRAINVAULT_TEST_PID_FILE;
if (pidFile === undefined) process.exit(2);

await Bun.write(pidFile, `${process.pid}\n`);
process.stderr.write('BVP1 1\n');
for await (const _chunk of Bun.stdin.stream()) {
  // Drain the private native wire input before simulating a stuck derivation.
}
await new Promise<never>(() => {});
