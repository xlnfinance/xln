#!/usr/bin/env bun

const pidFile = process.env.BRAINVAULT_TEST_PID_FILE;
if (pidFile !== undefined) await Bun.write(pidFile, `${process.pid}\n`);

process.on('SIGTERM', () => {});
for await (const _chunk of Bun.stdin.stream()) {
  // Drain the private native wire input before simulating a stalled sibling.
}
await Bun.sleep(2_000);
process.exit(9);
