import { expect, test } from 'bun:test';
import { executionPid } from './stack-manager-resume-support';

test('receipt-cut selection belongs to its caller and never selects an unrelated matching process', async () => {
  const decoy = Bun.spawn(['node', '-e', 'setInterval(() => {}, 1000)', 'hardhat', 'xln-deploy']);
  const caller = Bun.spawn(
    [
      'bun',
      '-e',
      `
    const child = Bun.spawn(['node', '-e', 'setInterval(() => {}, 1000)', 'hardhat', 'xln-deploy']);
    console.log(child.pid);
    await child.exited;
  `,
    ],
    { stdout: 'pipe' },
  );
  let ownedPid = 0;
  try {
    const reader = caller.stdout.getReader();
    const first = await reader.read();
    ownedPid = Number(new TextDecoder().decode(first.value).trim());
    expect(ownedPid).toBeGreaterThan(0);
    // Selection is observed before any signal. RED can never kill the decoy.
    expect(executionPid(caller.pid)).toBe(ownedPid);
    expect(decoy.exitCode).toBeNull();
    expect(() => process.kill(decoy.pid, 0)).not.toThrow();
  } finally {
    if (ownedPid) process.kill(ownedPid, 'SIGTERM');
    caller.kill('SIGTERM');
    decoy.kill('SIGTERM');
    await Promise.all([caller.exited, decoy.exited]);
  }
});
