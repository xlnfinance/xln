#!/usr/bin/env bun

const [cliPath, cliPidFile, ...cliArgs] = process.argv.slice(2);
if (cliPath === undefined || cliPidFile === undefined) process.exit(2);

const child = Bun.spawn(['bun', cliPath, ...cliArgs], {
  env: process.env,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
await Bun.write(cliPidFile, `${child.pid}\n`);
const nativePidPromise = (async (): Promise<number | undefined> => {
  while (child.exitCode === null) {
    const found = Bun.spawnSync({
      cmd: ['pgrep', '-P', String(child.pid)], stderr: 'pipe', stdout: 'pipe',
    });
    const nativePid = Number(found.stdout.toString().trim().split('\n')[0]);
    if (found.exitCode === 0 && Number.isSafeInteger(nativePid) && nativePid > 1) return nativePid;
    await Bun.sleep(10);
  }
  return undefined;
})();
const [exitCode, nativePid] = await Promise.all([child.exited, nativePidPromise]);
let nativeAlive = false;
if (nativePid !== undefined) {
  try {
    process.kill(nativePid, 0);
    nativeAlive = true;
  } catch {}
}
console.log(`NATIVE_ALIVE:${nativeAlive ? 1 : 0}`);
if (nativeAlive && nativePid !== undefined) {
  try { process.kill(nativePid, 'SIGKILL'); } catch {}
}
process.exit(exitCode);
