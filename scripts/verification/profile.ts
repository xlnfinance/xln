import { basename } from 'node:path';
import { git } from './git';

export type VerificationProfile = Readonly<{
  name: 'full' | 'deployment';
  reason: string;
  base: string | null;
  paths: readonly string[];
}>;

const deploymentRoots = [
  'jurisdictions/tasks/',
  'jurisdictions/scripts/deployment/',
  'jurisdictions/scripts/compiler/',
  'jurisdictions/scripts/usdc-reserve-roundtrip/',
  'jurisdictions/ignition/modules/',
  'jurisdictions/ignition/parameters/',
  'jurisdictions/test/',
  'jurisdictions/typechain-types/',
  'frontend/static/contracts/',
  'core/jurisdiction/adapter/stack-manager/',
  'core/__tests__/orchestrator/standalone-deployment/',
  'core/__tests__/testing/tooling/deployment/',
  'tools/deployment/',
  'docs/deployment/',
];
const deploymentFiles = new Set([
  'jurisdictions/hardhat.config.ts',
  'jurisdictions/foundry.toml',
  'jurisdictions/scripts/deploy-stack.cjs',
  'jurisdictions/scripts/foundation-hanko.cjs',
  'jurisdictions/scripts/usdc-reserve-roundtrip.ts',
  'core/scripts/deployment/stack-manager.ts',
  'core/__tests__/operations/release/foundation-hanko-deploy.test.ts',
  'core/__tests__/orchestrator/stack-manager-ignition-anvil.test.ts',
  'core/__tests__/orchestrator/stack-manager-routing.test.ts',
  'core/__tests__/orchestrator/stack-manager-validation.test.ts',
  'core/__tests__/network/jurisdiction/wrapped-native-listing.test.ts',
  'core/__tests__/network/jurisdiction/usdc/usdc-reserve-roundtrip.test.ts',
  'core/__tests__/network/jurisdiction/usdc/usdc-reserve-roundtrip-support.ts',
  'core/__tests__/network/jurisdiction/usdc/usdc-reserve-roundtrip-evidence.test.ts',
  'tsconfig.deployment.json',
  'docs/night-work-plan.md',
]);

const isDeploymentPath = (path: string): boolean => {
  // Shared signing/hash protocol changes need the wider owning gates even when
  // their Solidity implementation is also covered by contract tests. Types.sol
  // defines MessageType/ProofBody signed in both Solidity and TypeScript;
  // changing that schema plus generated artifacts must not select deployment.
  if (path.startsWith('jurisdictions/contracts/')) {
    const source = basename(path);
    return (
      path.endsWith('.sol') &&
      !/^(?:Hanko|HashLadder)/u.test(source) &&
      source !== 'Types.sol' &&
      source !== 'EntityTypes.sol'
    );
  }
  return deploymentFiles.has(path) || deploymentRoots.some(prefix => path.startsWith(prefix));
};

export const fullProfile = (reason: string, base: string | null = null): VerificationProfile => ({
  name: 'full',
  reason,
  base,
  paths: [],
});

export const profileForChanges = (paths: readonly string[], base: string): VerificationProfile => ({
  name: paths.length > 0 && paths.every(isDeploymentPath) ? 'deployment' : 'full',
  reason:
    paths.length === 0
      ? 'empty-change-range'
      : paths.every(isDeploymentPath)
        ? 'deployment-only'
        : 'broader-or-unknown-path',
  base,
  paths,
});

export const verificationProfile = (root: string, head: string, base?: string): VerificationProfile => {
  if (base === undefined) return fullProfile('no-base');
  if (/^0+$/u.test(base)) return fullProfile('new-remote-branch');
  const resolved = git(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim();
  if (git(root, ['merge-base', resolved, head]).trim() !== resolved) return fullProfile('non-ancestor-base', resolved);
  const paths = git(root, ['diff', '--no-renames', '--name-only', '-z', resolved, head]).split('\0').filter(Boolean);
  return profileForChanges(paths, resolved);
};

export const verificationBudget = (profile: VerificationProfile): number =>
  // The deployment runner owns a 25-minute stand budget; allow its cleanup to
  // finish before the outer watchdog. The previous measured run took 19 min.
  profile.name === 'deployment' ? 1_560_000 : 300_000;
