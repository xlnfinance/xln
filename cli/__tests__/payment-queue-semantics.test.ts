import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';

test('CLI payment success is explicitly queued command acceptance', () => {
  const pay = readFileSync(new URL('../lib/actions/pay.ts', import.meta.url), 'utf8');
  const daemon = readFileSync(new URL('../lib/daemon/server.ts', import.meta.url), 'utf8');
  const commands = readFileSync(new URL('../commands/index.ts', import.meta.url), 'utf8');

  expect(pay).toContain("submitQueued(session.env, input, 'payment'");
  expect(pay).not.toContain('() => true');
  expect(daemon).toContain("status: 'queued'");
  expect(daemon).toContain("evidence: 'runtime-input-committed'");
  expect(commands).toContain('Payment queued');
  expect(commands).not.toContain('Payment delivered');
});

test('noninteractive onboarding consumes the trusted passphrase environment instead of stdin', () => {
  const commands = readFileSync(new URL('../commands/index.ts', import.meta.url), 'utf8');
  expect(commands).toContain('const configuredPassphrase = resolvePassphrase()');
  expect(commands).toContain("const passphrase = configuredPassphrase || await ask('Encrypt wallet with passphrase: ', true)");
  expect(commands).toContain('if (!configuredPassphrase)');
});
