import { getAddress } from 'ethers';

export type DeploymentArguments = Readonly<{
  parameters: string | undefined;
  deploymentId: string | undefined;
  deploymentDir: string | undefined;
  mode: string | undefined;
}>;
export type DeploymentParameters = Readonly<{
  chainId: number;
  foundationRecipient?: string;
  stablecoin: Readonly<{ kind: 'existing'; address: string }> | Readonly<{ kind: 'test' }>;
  confirmations: number;
}>;

export const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('XLN_DEPLOY_OBJECT_REQUIRED');
  return value as Record<string, unknown>;
};

const exact = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void => {
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) {
    throw new Error('XLN_DEPLOY_PARAMETERS_KEYS_INVALID');
  }
};

const address = (value: unknown): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('XLN_DEPLOY_ADDRESS_INVALID');
  const normalized = getAddress(value);
  if (/^0x0{40}$/.test(normalized)) throw new Error('XLN_DEPLOY_ADDRESS_INVALID');
  return normalized;
};

export const decodeDeploymentParameters = (value: unknown): DeploymentParameters => {
  const input = record(value);
  exact(input, ['chainId', 'stablecoin', 'confirmations'], ['foundationRecipient']);
  const chainId = input['chainId'];
  const confirmations = input['confirmations'];
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId < 1) throw new Error('XLN_DEPLOY_CHAIN_ID_INVALID');
  if (typeof confirmations !== 'number' || !Number.isSafeInteger(confirmations) || confirmations < 12) throw new Error('XLN_DEPLOY_CONFIRMATIONS_INVALID');
  const token = record(input['stablecoin']);
  let stablecoin: DeploymentParameters['stablecoin'];
  if (token['kind'] === 'existing') {
    exact(token, ['kind', 'address']);
    stablecoin = { kind: 'existing', address: address(token['address']) };
  } else if (token['kind'] === 'test') {
    exact(token, ['kind']);
    stablecoin = { kind: 'test' };
  } else throw new Error('XLN_DEPLOY_TOKEN_KIND_INVALID');
  return { chainId, stablecoin, confirmations,
    ...('foundationRecipient' in input ? { foundationRecipient: address(input['foundationRecipient']) } : {}) };
};

export const decodeDeploymentIntent = (args: DeploymentArguments) => {
  if (!args.parameters) throw new Error('XLN_DEPLOY_PARAMETERS_REQUIRED');
  if (!args.deploymentId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(args.deploymentId)) throw new Error('XLN_DEPLOYMENT_ID_INVALID');
  if (args.mode !== 'new' && args.mode !== 'resume') throw new Error('XLN_DEPLOYMENT_MODE_INVALID');
  return { parameters: args.parameters, deploymentId: args.deploymentId, mode: args.mode };
};
