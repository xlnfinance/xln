/** Lending differential gate: regenerate each TS oracle in memory, then compare
 * Rust transitions, committed books, projections and snapshot roots against it. */
const commands = [
  ['bun', 'test', 'core/__tests__/rscore/parity/lending/complete.test.ts'],
  [
    'cargo',
    'test',
    '--manifest-path',
    'rscore/Cargo.toml',
    '-p',
    'xln-rscore-engine',
    '--test',
    'lending_parity',
    '--test',
    'lending_funding',
  ],
  ['cargo', 'test', '--manifest-path', 'rscore/Cargo.toml', '-p', 'xln-rscore-entity-kernel', '--lib', 'lendbook'],
  [
    'cargo',
    'test',
    '--manifest-path',
    'rscore/Cargo.toml',
    '-p',
    'xln-rscore-entity-kernel',
    '--lib',
    'same_j_semantic_parity',
  ],
  [
    'cargo',
    'test',
    '--manifest-path',
    'rscore/Cargo.toml',
    '-p',
    'xln-rscore-process',
    'restores_every_typescript_lending_snapshot_exactly',
  ],
];
for (const command of commands) {
  console.log(`LENDING_DIFFERENTIAL: ${command.join(' ')}`);
  const child = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit' });
  const exit = await child.exited;
  if (exit !== 0) process.exit(exit);
}
console.log('LENDING_DIFFERENTIAL: all TS/Rust comparisons passed');
