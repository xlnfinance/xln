/**
 * Files that can affect an XLN production release or its release evidence.
 *
 * This is deliberately an inclusion list. External/reference projects such as
 * brainvault/, ui/, design/ and ai/ have their own release lifecycle and must
 * not silently expand the XLN signed code root. BrainVault is an independent
 * product and its source tree is never part of XLN release immutability.
 */
export const XLN_RELEASE_PATHS = [
  '.github',
  '.eslintrc',
  '.prettierrc',
  'AGENTS.md',
  'CHANGELOG.md',
  'LICENSE',
  'VERSION',
  'audits',
  'bun.lock',
  'cli',
  'core',
  'custody',
  'docs',
  'foundation-release-board.json',
  'frontend',
  'frozen-core.json',
  'jurisdictions',
  'knip.json',
  'native',
  'ops',
  'package.json',
  'packages',
  'playwright.config.ts',
  'proofs',
  'readme.md',
  'release',
  'rscore',
  'rust-toolchain.toml',
  'scripts',
  'stryker.fints.config.mjs',
  'tests',
  'tools',
  'tsconfig.fints-negative.json',
  'tsconfig.fints-positive.json',
  'tsconfig.fints-widened.json',
  'tsconfig.json',
  'tsconfig.runtime-contract-tests.json',
  'tsconfig.runtime.json',
  'types',
] as const;

export const isXlnReleasePath = (
  path: string,
  scope: readonly string[] = XLN_RELEASE_PATHS,
): boolean => scope.some(root => path === root || path.startsWith(`${root}/`));
