#!/usr/bin/env bun

process.on('SIGTERM', () => {});
void Bun.write(Bun.stderr, 'BVP1 0\n');
for await (const _chunk of Bun.stdin.stream()) {
  // Drain input, then model a child that refuses graceful termination.
}
await Bun.sleep(60_000);
