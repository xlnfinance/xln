import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { verifyOrigin } from '../deployment/origin.cjs';
import { candidateRevision } from '../deployment/evidence.cjs';
import { readVerificationInputs, assertVerificationInputsUnchanged } from '../deployment/operator/readonly-identity';
import { verifyReadonlyJournal } from '../deployment/operator/readonly-journal';
import { decodeRegisteredStackStablecoin } from '../../../core/jurisdiction/adapter/stack-manager/validation';
import { verifyJurisdictionStack } from '../../../core/jurisdiction/adapter/stack-manager/verification';
import {
  readCanonicalChainPoint,
  assertCanonicalChainPoint,
} from '../../../core/jurisdiction/adapter/stack-manager/receipts';
import type { JsonRpcProvider } from 'ethers';
import type { RoundtripOptions } from './types';

export const captureProbeIdentity = async () => {
  const files = [
    'usdc-reserve-roundtrip.ts',
    ...['types', 'inputs', 'verification', 'balances', 'transactions', 'runner'].map(
      name => `usdc-reserve-roundtrip/${name}.ts`,
    ),
  ];
  const sources = Object.fromEntries(
    await Promise.all(
      files.map(async path => [
        `jurisdictions/scripts/${path}`,
        createHash('sha256')
          .update(await readFile(new URL(`../${path}`, import.meta.url)))
          .digest('hex'),
      ]),
    ),
  );
  return { ...candidateRevision(), sources };
};

export const verifyRoundtripDeployment = async (options: RoundtripOptions, provider: JsonRpcProvider) => {
  const input = await readVerificationInputs(await realpath(resolve(options.deploymentDir)));
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(options.chainId) || input.manifest.chainId !== options.chainId)
    throw new Error('USDC_ROUNDTRIP_CHAIN_MISMATCH');
  const token = decodeRegisteredStackStablecoin(input.manifest.registeredTokens);
  if (token.address !== options.token || token.symbol !== 'USDC')
    throw new Error('USDC_ROUNDTRIP_TOKEN_BINDING_MISMATCH');
  const confirmations = options.confirmations ?? input.confirmations;
  if (confirmations < input.confirmations) throw new Error('USDC_ROUNDTRIP_CONFIRMATIONS_BELOW_DEPLOYMENT');
  const point = await readCanonicalChainPoint(provider);
  await verifyOrigin(input.identity.origin, provider, input.deployer);
  await verifyReadonlyJournal(input, provider);
  await verifyJurisdictionStack(provider, input.manifest, confirmations, point.number, input.artifactsRoot);
  // Original sealed evidence authenticates the deployment; today's canonical
  // artifacts independently prevent an obsolete stack from certifying this probe.
  await verifyJurisdictionStack(provider, input.manifest, confirmations, point.number);
  await assertVerificationInputsUnchanged(input);
  await assertCanonicalChainPoint(provider, point);
  return { input, confirmations, point, token };
};
