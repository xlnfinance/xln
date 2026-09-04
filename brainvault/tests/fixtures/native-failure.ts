#!/usr/bin/env bun

process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write('native failure at /Users/example/brainvault/SENSITIVE-PATH\n');
  process.exit(7);
});
