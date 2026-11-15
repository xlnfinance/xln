import { safeStringify } from '../../../../protocol/serialization';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { startResumeNode, privateKey } from '../../stack-manager-recovery/stack-manager-resume-support';
import { expect } from 'bun:test';

export const startStandaloneNode = async (cut: number, extraNonce = 0) => {
  const fixture = await startResumeNode(cut, extraNonce);
  const parameters = join(fixture.directory, 'parameters.json');
  await writeFile(parameters, safeStringify({ chainId: 31337, stablecoin: fixture.request.stablecoin, confirmations: 12 }));
  const nativeDirectory = join(fixture.directory, 'native');
  const start = (mode: 'new' | 'resume', name: string, rpcUrl?: string) => {
    // The common proxy must observe the native process for the real SIGKILL cut.
    return fixture.startNative({ parameters, nativeDirectory, mode, name, ...(rpcUrl ? { rpcUrl } : {}) });
  };
  return { ...fixture, parameters, nativeDirectory, start };
};

export const assertVariantLaneLocked = async (fixture: Awaited<ReturnType<typeof startStandaloneNode>>): Promise<void> => {
  const child = Bun.spawn(['bunx', 'hardhat', 'xln-chain-stack', '--network', 'stack-manager'], {
    cwd: join(process.cwd(), 'jurisdictions'), stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env['PATH'] || '', DEPLOYER_PRIVATE_KEY: privateKey,
      XLN_STACK_MANAGER_RPC_URL: fixture.request.rpcUrl, XLN_STACK_MANAGER_CHAIN_ID: '31337',
      XLN_DEPLOYMENT_ID: 'competing-variant', XLN_DEPLOYMENT_MODE: 'new',
      XLN_DEPLOY_OUTPUT: join(fixture.directory, 'competing-variant', 'manifest.json'),
      XLN_STABLECOIN_ADDRESS: fixture.request.stablecoin.address },
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).not.toBe(0);
  expect(stdout + stderr).toContain('XLN_DEPLOY_SIGNER_CHAIN_ACTIVE');
};
