import { task } from 'hardhat/config';
import { ArgumentType } from 'hardhat/types/arguments';

export const xlnVerify = task('xln-verify', 'Read-only verification of an existing sealed XLN EVM deployment')
  .addOption({
    name: 'deploymentDir',
    description: 'Existing native deployment directory',
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
    defaultValue: undefined,
  })
  .addOption({
    name: 'output',
    description: 'New verification report outside the deployment directory (default: stdout)',
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
    defaultValue: undefined,
  })
  .setAction(() => import('./verify.ts'))
  .build();
