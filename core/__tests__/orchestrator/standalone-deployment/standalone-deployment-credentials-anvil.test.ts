import { expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStringify } from '../../../protocol/serialization';
import { startStandaloneNode } from './standalone-deployment-support';
import { launchDeployment } from './standalone-deployment-process-support';
import { readJson } from './standalone-deployment-transactions-support';

const querySecret = 'public_anvil_fixture_query_credential';
const pathSecret = 'public_anvil_fixture_path_credential';
const nativeText = async (directory: string): Promise<string> => {
  if (!(await Bun.file(join(directory, 'journal.jsonl')).exists())) return '';
  const files = ['journal.jsonl', 'result.json', 'manifest.json.execution.json'];
  for (const entry of await readdir(join(directory, 'invocations'))) files.push(`invocations/${entry}/result.json`);
  return (await Promise.all(files.map(path => readFile(join(directory, path), 'utf8')))).join('\n');
};

test.each(['early', 'execution'] as const)(
  '%s RPC failures redact nested endpoint credentials before durable output',
  async phase => {
    const fixture = await startStandaloneNode(0);
    let rpcUrl = '';
    let faults = 0;
    let faultPayload = '';
    const proxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = await request.text();
        const input = JSON.parse(body);
        if (input.method === (phase === 'early' ? 'eth_getCode' : 'eth_sendRawTransaction')) {
          faults++;
          const detail = safeStringify({ diagnostic: { endpoint: rpcUrl, apiKey: querySecret, pathKey: pathSecret } });
          faultPayload = detail;
          return Response.json({
            jsonrpc: '2.0',
            id: input.id,
            error: { code: -32000, message: `FIXTURE_RPC_DENIED: ${detail}`, data: { detail } },
          });
        }
        return fetch(fixture.request.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      },
    });
    rpcUrl = `http://127.0.0.1:${proxy.port}/${pathSecret}?api_key=${querySecret}`;
    const session = launchDeployment(fixture, `credentials-${phase}`, { rpcUrl });
    try {
      expect(await session.exited).not.toBe(0);
      expect(faults).toBeGreaterThan(0);
      expect(faultPayload).toContain(querySecret);
      expect(faultPayload).toContain(pathSecret);
      expect(fixture.submissions()).toBe(0);
      expect(
        Number(BigInt(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest']))),
      ).toBe(fixture.initialNonce);
      const evidence = `${await session.log()}\n${await readFile(join(fixture.directory, `credentials-${phase}.json`), 'utf8')}\n${await nativeText(fixture.nativeDirectory)}`;
      expect(evidence).toContain('FIXTURE_RPC_DENIED');
      for (const secret of [querySecret, pathSecret])
        expect(evidence.includes(secret), 'credentials absent from logs and durable outcomes').toBeFalse();
      if (phase === 'execution') {
        const result = await readJson(join(fixture.nativeDirectory, 'result.json'));
        expect(result.status).toBe('failed');
        expect(result.phase).toBe('deploying');
        expect(result.expenses.attemptTransactionFeesWei).toBe('0');
      }
    } finally {
      await session.stop();
      await proxy.stop(true);
      await fixture.close();
    }
  },
  60_000,
);
