#!/usr/bin/env bun

import { readFileSync } from 'node:fs';

const [cliPath, cliPidFile, nativePidFile, ...cliArgs] = process.argv.slice(2);
if (cliPath === undefined || cliPidFile === undefined || nativePidFile === undefined) process.exit(2);

const child = Bun.spawn(['bun', cliPath, ...cliArgs], {
  env: { ...process.env, BRAINVAULT_TEST_PID_FILE: nativePidFile },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
await Bun.write(cliPidFile, `${child.pid}\n`);
const exitCode = await child.exited;
const nativePid = Number(readFileSync(nativePidFile, 'utf8').trim());
let nativeAlive = false;
try {
  process.kill(nativePid, 0);
  nativeAlive = true;
} catch {}
console.log(`NATIVE_ALIVE:${nativeAlive ? 1 : 0}`);
if (nativeAlive) {
  try { process.kill(nativePid, 'SIGKILL'); } catch {}
}
process.exit(exitCode);
