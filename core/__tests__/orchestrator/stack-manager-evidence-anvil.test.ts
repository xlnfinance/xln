import { expect, test } from 'bun:test';
import { JsonRpcProvider, Wallet, getBytes } from 'ethers';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERC20Mock__factory } from '../../../jurisdictions/typechain-types/factories/ERC20Mock__factory';
import { deployJurisdictionStack } from '../../jurisdiction/adapter/stack-manager/deploy';
import {
  decodeDeployJurisdictionStackRequest,
  decodeJurisdictionStackManifest,
} from '../../jurisdiction/adapter/stack-manager/validation';
import { waitForRpcReady } from '../../scripts/operations/settlement/rpc-settlement-anvil';

const ANVIL_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
test('preserves mined deployment evidence and blocks blind retry after discovery persistence fails', async () => {
  const anvil = Bun.which('anvil');
  if (!anvil) throw new Error('ANVIL_BINARY_REQUIRED');
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
  const port = reservation.port;
  await reservation.stop(true);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const node = Bun.spawn(
    [
      anvil,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--chain-id',
      '31337',
      '--block-time',
      '0.1',
      '--block-gas-limit',
      '60000000',
      '--code-size-limit',
      '65536',
      '--silent',
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  const provider = new JsonRpcProvider(rpcUrl);
  const directory = await mkdtemp(join(tmpdir(), 'xln-stack-manager-evidence-'));
  const discoveryPath = join(directory, 'jurisdictions.json');
  const evidenceDirectory = join(directory, 'evidence');
  const previous = process.env['XLN_JURISDICTIONS_PATH'];
  process.env['XLN_JURISDICTIONS_PATH'] = discoveryPath;
  try {
    await waitForRpcReady(rpcUrl, 5_000);
    const wallet = new Wallet(ANVIL_PRIVATE_KEY, provider);
    const token = await new ERC20Mock__factory(wallet).deploy('USD Coin Test', 'USDC', 6, 1_000_000n);
    await token.waitForDeployment();
    const request = decodeDeployJurisdictionStackRequest({
      stackVersion: 'V1',
      name: 'Late persistence failure',
      key: `anvil-evidence-${port}`,
      rpcUrl,
      expectedChainId: 31337,
      blockTimeMs: 250,
      currency: 'ETH',
      explorer: '',
      signerId: wallet.address,
      foundationRecipient: wallet.address,
      stablecoin: { kind: 'existing', address: await token.getAddress() },
      publication: 'local',
      confirmations: 12,
    });
    const attemptDirectory = join(evidenceDirectory, request.key);
    const phases: string[] = [];
    const nonceBefore = BigInt(await provider.send('eth_getTransactionCount', [wallet.address, 'pending']));
    let failure: unknown;
    try {
      await deployJurisdictionStack(request, {
        deploymentId: request.key,
        mode: 'new',
        signerPrivateKey: getBytes(ANVIL_PRIVATE_KEY),
        evidenceDirectory,
        onPhase: phase => {
          phases.push(phase);
          // A real filesystem failure occurs only after the actual stack is verified.
          if (phase === 'persisting') mkdirSync(discoveryPath);
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(BigInt(await provider.send('eth_getTransactionCount', [wallet.address, 'pending'])) - nonceBefore).toBe(11n);
    expect(phases).toContain('persisting');
    expect(phases).not.toContain('complete');
    expect((await stat(discoveryPath)).isDirectory()).toBeTrue();
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('EISDIR');
    expect(String(failure)).toContain('illegal operation on a directory, read');
    expect(String(failure).length).toBeLessThanOrEqual(8_192);

    const manifestText = await readFile(join(attemptDirectory, 'manifest.json'), 'utf8');
    const resultText = await readFile(join(attemptDirectory, 'result.json'), 'utf8');
    const transactionsText = await readFile(join(attemptDirectory, 'manifest.json.transactions.json'), 'utf8');
    const manifest = decodeJurisdictionStackManifest(JSON.parse(manifestText));
    const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
    expect(git.exitCode).toBe(0);
    const outcome = JSON.parse(resultText);
    expect(outcome).toMatchObject({
      status: 'complete',
      phase: 'complete',
      candidate: { sha: git.stdout.toString().trim(), dirty: expect.any(Boolean) },
      candidateSha: git.stdout.toString().trim(),
      sources: {
        'jurisdictions/scripts/deployment/dispatch.cjs': sha256(
          await readFile(new URL('../../../jurisdictions/scripts/deployment/dispatch.cjs', import.meta.url)),
        ),
      },
      verification: { exactBytecode: true, constructorsAndBindings: true, foundationAndToken: true, confirmations: 12 },
      expenses: { broadcasts: 11, mined: 11, balance: { unaccountedDeltaWei: '0' } },
    });
    expect(outcome.error).toBeUndefined();
    const sealText = await readFile(join(attemptDirectory, 'manifest.json.execution.json'), 'utf8');
    expect(JSON.parse(sealText).artifacts).toMatchObject({
      'jurisdictions/artifacts/contracts/Depository.sol/Depository.json': sha256(
        await readFile(
          new URL('../../../jurisdictions/artifacts/contracts/Depository.sol/Depository.json', import.meta.url),
        ),
      ),
    });
    const archivedResult = join(outcome.invocation, 'result.json');
    expect(await readFile(archivedResult, 'utf8')).toBe(resultText);
    const receipts = JSON.parse(transactionsText) as ReadonlyArray<{
      txHash: string;
      receipt: { hash: string; status: number; blockNumber: number; blockHash: string };
    }>;
    expect(receipts).toHaveLength(11);
    expect(new Set(receipts.map(entry => entry.txHash)).size).toBe(11);
    const journal = await readFile(join(attemptDirectory, 'journal.jsonl'), 'utf8');
    expect(journal).toContain(`XlnListing_${Buffer.from(request.key).toString('hex')}#registerStablecoin`);
    let creations = 0;
    for (const entry of receipts) {
      const receipt = await provider.getTransactionReceipt(entry.txHash);
      if (!receipt) throw new Error('TEST_PRESERVED_RECEIPT_MISSING');
      expect(entry.receipt).toMatchObject({
        hash: receipt.hash,
        status: 1,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
      });
      if (receipt.contractAddress) {
        creations += 1;
        expect(Object.values(manifest.contracts)).toContain(receipt.contractAddress);
        expect(await provider.getCode(receipt.contractAddress)).not.toBe('0x');
      }
    }
    expect(creations).toBe(8);
    const allEvidence = `${manifestText}${resultText}${transactionsText}`;
    expect(allEvidence).not.toContain(ANVIL_PRIVATE_KEY.slice(2));
    expect(allEvidence).not.toContain(rpcUrl);

    // Restore the output path: only the preserved attempt may prevent a second spend.
    await rm(discoveryPath, { recursive: true });
    const nonceAfterFailure = await provider.send('eth_getTransactionCount', [wallet.address, 'pending']);
    await expect(
      deployJurisdictionStack(request, {
        deploymentId: request.key,
        mode: 'new',
        signerPrivateKey: getBytes(ANVIL_PRIVATE_KEY),
        evidenceDirectory,
      }),
    ).rejects.toThrow('STACK_MANAGER_DEPLOYMENT_ATTEMPT_EXISTS');
    expect(await provider.send('eth_getTransactionCount', [wallet.address, 'pending'])).toBe(nonceAfterFailure);
    expect(await Bun.file(discoveryPath).exists()).toBeFalse();
    expect(await readFile(join(attemptDirectory, 'manifest.json'), 'utf8')).toBe(manifestText);
    expect(await readFile(join(attemptDirectory, 'result.json'), 'utf8')).toBe(resultText);
    expect(await readFile(join(attemptDirectory, 'manifest.json.transactions.json'), 'utf8')).toBe(transactionsText);
    const resumed = await deployJurisdictionStack(request, {
      deploymentId: request.key,
      mode: 'resume',
      signerPrivateKey: getBytes(ANVIL_PRIVATE_KEY),
      evidenceDirectory,
    });
    expect(resumed.manifest).toEqual(manifest);
    expect(resumed.localJurisdiction.key).toBe(request.key);
    expect(await provider.send('eth_getTransactionCount', [wallet.address, 'pending'])).toBe(nonceAfterFailure);
    expect(await readFile(archivedResult, 'utf8')).toBe(resultText);
    expect(await readFile(join(attemptDirectory, 'manifest.json.execution.json'), 'utf8')).toBe(sealText);
    expect(await readFile(join(attemptDirectory, 'journal.jsonl'), 'utf8')).toBe(journal);
    expect(
      JSON.parse(await readFile(join(attemptDirectory, 'result.json'), 'utf8')).expenses.attemptTransactionFeesWei,
    ).toBe(outcome.expenses.attemptTransactionFeesWei);
  } finally {
    provider.destroy();
    node.kill('SIGTERM');
    await node.exited;
    if (previous === undefined) delete process.env['XLN_JURISDICTIONS_PATH'];
    else process.env['XLN_JURISDICTIONS_PATH'] = previous;
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
