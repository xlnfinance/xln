import { safeStringify } from '../../protocol/serialization';
import { expect, test } from 'bun:test';
import { getBytes, Wallet } from 'ethers';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStackManagerController } from '../../api/server/control/stack-manager';
import { createEmptyEnv } from '../../runtime';
import { registerSignerKey } from '../../account/crypto';

const privateKey = `0x${'11'.repeat(32)}`;
const signer = new Wallet(privateKey).address;
const request = { name: 'Routing', key: 'routing', rpcUrl: 'http://127.0.0.1:1',
  expectedChainId: 31337, blockTimeMs: 250, currency: 'ETH', explorer: '', signerId: signer,
  foundationRecipient: signer, stablecoin: { kind: 'test' }, publication: 'local', confirmations: 12 };
const execution = { deploymentId: 'routing-identity', mode: 'resume' };

test('CLI and private worker route explicit resume intent to the production seam', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xln-stack-routing-'));
  try {
    const config = join(directory, 'request.json');
    await writeFile(config, safeStringify(request));
    const commands = [
      { cmd: ['bun', 'core/scripts/deployment/stack-manager.ts', '--config', config, '--deployment-id', execution.deploymentId, '--mode', 'resume'], input: undefined },
      { cmd: ['bun', 'core/api/server/control/stack-manager/native-worker.ts'], input: safeStringify({ op: 'deploy', request, execution, signerPrivateKey: privateKey }) },
    ];
    for (const { cmd, input } of commands) {
      const child = Bun.spawn(cmd, { env: { PATH: process.env['PATH'] || '', DEPLOYER_PRIVATE_KEY: privateKey }, stdin: input ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe' });
      if (input && child.stdin) { child.stdin.write(input); child.stdin.end(); }
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code).toBe(1);
      expect(`${stdout}${stderr}`).toContain('STACK_MANAGER_DEPLOYMENT_IDENTITY_INVALID');
      expect(`${stdout}${stderr}`).not.toContain(privateKey.slice(2));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('server routes the execution envelope and rejects obsolete flat deployment input', async () => {
  const env = createEmptyEnv('stack-manager-routing');
  registerSignerKey(env, signer.toLowerCase(), getBytes(privateKey));
  const controller = createStackManagerController({ parseBody: req => req.json(), headers: {} });
  const post = (body: unknown) => controller.deploy(new Request('http://localhost/api/control/stack-manager/deploy', {
    method: 'POST', body: safeStringify(body), headers: { 'content-type': 'application/json' },
  }), env);
  expect(await (await post({ request, execution })).json()).toMatchObject({ ok: false, error: expect.stringContaining('STACK_MANAGER_DEPLOYMENT_IDENTITY_INVALID') });
  expect(await (await post(request)).json()).toMatchObject({ ok: false, error: expect.stringContaining('STACK_MANAGER_INVOCATION_KEYS_INVALID') });
  expect(await (await post({ request, execution: { deploymentId: '../other', mode: 'new' } })).json())
    .toMatchObject({ ok: false, error: 'STACK_MANAGER_DEPLOYMENT_ID_INVALID' });
  expect(await (await post({ request, execution: { deploymentId: 'fresh' } })).json())
    .toMatchObject({ ok: false, error: 'STACK_MANAGER_EXECUTION_KEYS_INVALID' });
});
