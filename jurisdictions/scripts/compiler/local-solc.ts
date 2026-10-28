import { resolve } from 'node:path';
import type { SolidityHooks } from 'hardhat/types/hooks';

export default async (): Promise<Partial<SolidityHooks>> => ({
  async getCompiler(context, compilerConfig, next) {
    if (compilerConfig.path === undefined) throw new Error('XLN_LOCAL_SOLC_PATH_REQUIRED');
    // Hardhat's solcjs runner needs an absolute import path, but its build ID
    // hashes the original compiler config. Resolve only this loader copy;
    // mutating compilerConfig would reintroduce checkout-dependent artifacts.
    return next(context, {
      ...compilerConfig,
      path: resolve(context.config.paths.root, compilerConfig.path),
    });
  },
});
