#!/usr/bin/env bun

process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write('BVP1 0\n');
  setTimeout(() => {}, 30_000);
});
