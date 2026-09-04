#!/usr/bin/env bun

if (Object.keys(process.env).some(key => key.startsWith('DYLD_') || key.startsWith('LD_'))) {
  process.exit(8);
}
process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write('native failure at /Users/example/brainvault/SENSITIVE-PATH\n');
  process.exit(7);
});
