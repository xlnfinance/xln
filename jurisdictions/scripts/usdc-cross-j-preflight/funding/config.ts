import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getAddress } from 'ethers';

export type FundingConfig = Readonly<{
  action: 'prepare' | 'run';
  directory: string;
  userVault?: string;
  catalogPath: string;
  funder: string;
  limitsPath: string;
  authorityPath: string;
  keyEnv: string;
  output: string;
}>;

export const readFundingConfig = (args: readonly string[]): FundingConfig => {
  const [action, ...rest] = args;
  if (action !== 'prepare' && action !== 'run') throw new Error('USDC_FUNDING_ACTION_REQUIRED');
  const allowed =
    action === 'prepare'
      ? ['--directory', '--user-vault', '--funder-address', '--limits-file', '--output']
      : ['--directory', '--user-vault', '--authority-file', '--key-env', '--output'];
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!,
      value = rest[i + 1];
    if (!allowed.includes(key) || !value || value.startsWith('--') || options.has(key))
      throw new Error('USDC_FUNDING_OPTION_INVALID');
    options.set(key, value);
  }
  const required = (key: string): string => {
    const value = options.get(key);
    if (!value) throw new Error(`USDC_FUNDING_OPTION_REQUIRED:${key}`);
    return value;
  };
  const directory = realpathSync(resolve(required('--directory')));
  const output = resolve(required('--output'));
  const userVault = options.get('--user-vault');
  if (existsSync(output)) throw new Error('USDC_FUNDING_OUTPUT_EXISTS');
  const keyEnv = action === 'run' ? required('--key-env') : '';
  if (keyEnv && !/^[A-Z][A-Z0-9_]+$/.test(keyEnv)) throw new Error('USDC_FUNDING_KEY_ENV_INVALID');
  return {
    action,
    directory,
    ...(userVault ? { userVault: realpathSync(resolve(userVault)) } : {}),
    catalogPath: realpathSync(join(directory, 'jurisdictions.json')),
    output,
    funder: action === 'prepare' ? getAddress(required('--funder-address')).toLowerCase() : '',
    keyEnv,
    limitsPath: action === 'prepare' ? realpathSync(resolve(required('--limits-file'))) : '',
    authorityPath: action === 'run' ? realpathSync(resolve(required('--authority-file'))) : '',
  };
};
