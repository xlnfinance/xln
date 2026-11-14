import { join } from 'node:path';
import { committedDeploymentConfig } from '../../orchestrator/standalone-deployment/standalone-deployment-readonly-support';
import { startStandaloneNode } from '../../orchestrator/standalone-deployment/standalone-deployment-support';
import { launchDeployment } from '../../orchestrator/standalone-deployment/standalone-deployment-process-support';
import { finish } from '../../orchestrator/standalone-deployment/standalone-deployment-transactions-support';
import { privateKey } from '../../orchestrator/stack-manager-recovery/stack-manager-resume-support';
import { HDNodeWallet, Wallet } from 'ethers';
import { runUsdcReserveRoundtrip } from '../../../../jurisdictions/scripts/usdc-reserve-roundtrip/runner';

export const roundtripFixture = async () => {
  const source = await committedDeploymentConfig();
  const fixture = await startStandaloneNode(0);
  const session = launchDeployment(fixture, 'roundtrip-stack', {
    config: source.config,
    environment: source.environment,
  });
  try {
    const deployment = await finish(fixture, session);
    return {
      ...fixture,
      deployment,
      close: async () => {
        await session.stop();
        await fixture.close();
        await source.close();
      },
    };
  } catch (error) {
    await session.stop();
    await fixture.close();
    await source.close();
    throw error;
  }
};

export const roundtripEvidence = async (fixture: Awaited<ReturnType<typeof roundtripFixture>>) => {
  const previous = [process.env['DEPLOYER_PRIVATE_KEY'], process.env['XLN_STACK_MANAGER_RPC_URL']];
  process.env['DEPLOYER_PRIVATE_KEY'] = privateKey;
  process.env['XLN_STACK_MANAGER_RPC_URL'] = fixture.directRpcUrl;
  try {
    return await runUsdcReserveRoundtrip({
      network: 'local',
      chainId: 31337,
      token: fixture.request.stablecoin.address,
      deploymentDir: fixture.nativeDirectory,
    });
  } finally {
    for (const [index, key] of ['DEPLOYER_PRIVATE_KEY', 'XLN_STACK_MANAGER_RPC_URL'].entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
  }
};

type CommandOptions = Readonly<{
  chainId?: number;
  token?: string;
  confirmations?: number;
  key?: string;
  rpc?: string;
  afterDeposit?: (hash: string) => Promise<void>;
}>;

const readProgress = async (stream: ReadableStream<Uint8Array>, callback: CommandOptions['afterDeposit']) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';
  let handled = false;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return output;
    output += decoder.decode(chunk.value, { stream: true });
    const deposit = /USDC_ROUNDTRIP_BROADCAST:deposit:(0x[0-9a-f]{64})/.exec(output);
    if (callback && deposit && !handled) {
      handled = true;
      await callback(deposit[1]!);
    }
  }
};

export const probeCommand = async (
  fixture: Awaited<ReturnType<typeof roundtripFixture>>,
  options: CommandOptions = {},
) => {
  const child = Bun.spawn(
    [
      'bun',
      'jurisdictions/scripts/usdc-reserve-roundtrip.ts',
      '--network=local',
      `--chain-id=${options.chainId ?? 31337}`,
      `--token=${options.token ?? fixture.request.stablecoin.address}`,
      `--deployment-dir=${fixture.nativeDirectory}`,
      ...(options.confirmations ? [`--confirmations=${options.confirmations}`] : []),
    ],
    {
      env: {
        ...process.env,
        DEPLOYER_PRIVATE_KEY: options.key ?? privateKey,
        XLN_STACK_MANAGER_RPC_URL: options.rpc ?? fixture.directRpcUrl,
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    },
  );
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      readProgress(child.stderr, options.afterDeposit),
    ]);
    return { code, stdout, stderr, evidence: join(fixture.directory, 'local-roundtrip.json') };
  } catch (error) {
    child.kill('SIGTERM');
    await child.exited;
    throw error;
  }
};

export const externalWallet = (fixture: Awaited<ReturnType<typeof roundtripFixture>>) =>
  new Wallet(
    HDNodeWallet.fromPhrase(
      'test test test test test test test test test test test junk',
      undefined,
      "m/44'/60'/0'/0/1",
    ).privateKey,
    fixture.provider,
  );

export const drainNativeBalance = async (wallet: Wallet): Promise<void> => {
  if (!wallet.provider) throw new Error('ROUNDTRIP_TEST_PROVIDER_REQUIRED');
  const balance = await wallet.provider.getBalance(wallet.address);
  const { gasPrice } = await wallet.provider.getFeeData();
  if (!gasPrice) throw new Error('ROUNDTRIP_TEST_GAS_PRICE_REQUIRED');
  const nonce = await wallet.getNonce('pending');
  const transaction = await wallet.sendTransaction({
    to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    value: balance - 21_000n * gasPrice,
    gasPrice,
    gasLimit: 21_000n,
    nonce,
  });
  await transaction.wait();
};
