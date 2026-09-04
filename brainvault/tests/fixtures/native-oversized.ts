#!/usr/bin/env bun

process.on('SIGTERM', () => {});
for await (const _chunk of Bun.stdin.stream()) {
  // Drain input before violating the fixed-size output protocol.
}
await Bun.write(Bun.stdout, new Uint8Array(33));
await Bun.sleep(60_000);
