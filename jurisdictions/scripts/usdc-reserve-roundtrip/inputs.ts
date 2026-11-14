import { getAddress } from 'ethers';
import { requireBoundaryInteger } from '../../../core/protocol/boundary-validation';
import type { RoundtripOptions } from './types';

const targets = {
  'ethereum-sepolia': { chainId: 11155111, token: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
  'arbitrum-sepolia': { chainId: 421614, token: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' },
} as const;

export const validateRoundtripOptions = (input: RoundtripOptions, rpc: string): RoundtripOptions => {
  const chainId = requireBoundaryInteger(input.chainId, 'USDC_ROUNDTRIP_CHAIN_INVALID', 1);
  const token = getAddress(input.token);
  if (!input.deploymentDir.trim()) throw new Error('USDC_ROUNDTRIP_DEPLOYMENT_DIRECTORY_REQUIRED');
  if (input.confirmations !== undefined)
    requireBoundaryInteger(input.confirmations, 'USDC_ROUNDTRIP_CONFIRMATIONS_INVALID', 12);
  const endpoint = new URL(rpc);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('USDC_ROUNDTRIP_RPC_PROTOCOL_INVALID');
  if (input.network === 'local') {
    if (chainId !== 31337 || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))
      throw new Error('USDC_ROUNDTRIP_LOCAL_NETWORK_INVALID');
  } else {
    const target = targets[input.network];
    if (!target || chainId !== target.chainId || token !== getAddress(target.token))
      throw new Error('USDC_ROUNDTRIP_PUBLIC_TARGET_INVALID');
  }
  return { ...input, token, chainId };
};

export const readRoundtripArguments = (args: string[]): RoundtripOptions => {
  const values: Record<string, string> = {};
  for (const argument of args) {
    const match = /^--(network|chain-id|token|deployment-dir|confirmations)=(.+)$/.exec(argument);
    if (!match || values[match[1]!]) throw new Error('USDC_ROUNDTRIP_ARGUMENT_INVALID');
    values[match[1]!] = match[2]!;
  }
  for (const name of ['network', 'chain-id', 'token', 'deployment-dir'])
    if (!values[name]) throw new Error(`USDC_ROUNDTRIP_ARGUMENT_REQUIRED:${name}`);
  const network = values['network'];
  if (network !== 'local' && network !== 'ethereum-sepolia' && network !== 'arbitrum-sepolia')
    throw new Error('USDC_ROUNDTRIP_NETWORK_INVALID');
  return {
    network,
    chainId: Number(values['chain-id']),
    token: values['token']!,
    deploymentDir: values['deployment-dir']!,
    ...(values['confirmations'] ? { confirmations: Number(values['confirmations']) } : {}),
  };
};
