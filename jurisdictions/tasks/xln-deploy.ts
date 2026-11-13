import { task } from 'hardhat/config';
import { ArgumentType } from 'hardhat/types/arguments';

export const xlnDeploy = task('xln-deploy', 'Deploy, resume and verify one XLN EVM stack')
  .addOption({ name: 'parameters', description: 'Strict XLN deployment parameters JSON', type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
  .addOption({ name: 'deploymentId', description: 'Explicit native deployment identity', type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
  .addOption({ name: 'deploymentDir', description: 'Exact native deployment directory', type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
  .addOption({ name: 'mode', description: 'new or resume', type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
  .setAction(() => import('./deploy.ts'))
  .build();

export const xlnChainStack = task('xln-chain-stack', 'Dispatch existing chain fixture/wrapped-token operations')
  .setAction(() => import('./chain-stack.ts'))
  .build();
