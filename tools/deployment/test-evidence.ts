import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { KEEP_TEST_ARTIFACTS_ENV } from '../../core/scripts/e2e/harness/test-artifact-cleanup';

export const DEPLOYMENT_TEST_FIXTURES_ENV = 'XLN_DEPLOYMENT_TEST_FIXTURES_DIR';

const requireOwnedDirectory = (directory: string, identity: Stats): void => {
  const observed = lstatSync(directory);
  if (
    !observed.isDirectory() ||
    observed.dev !== identity.dev ||
    observed.ino !== identity.ino ||
    realpathSync(directory) !== directory
  )
    throw new Error(`DEPLOYMENT_FIXTURE_OWNERSHIP_LOST:${directory}`);
};

export const createDeploymentTestEvidence = (reportDirectory: string, env = process.env) => {
  const parent = resolve(reportDirectory);
  const parentIdentity = lstatSync(parent);
  requireOwnedDirectory(parent, parentIdentity);
  const directory = join(parent, 'fixtures');
  mkdirSync(directory, { mode: 0o700 });
  const identity = lstatSync(directory);
  const keep = /^(1|true|yes)$/u.test(
    String(env[KEEP_TEST_ARTIFACTS_ENV] || '')
      .trim()
      .toLowerCase(),
  );
  return {
    directory,
    assertReportOwnership: (): void => requireOwnedDirectory(parent, parentIdentity),
    complete: (passed: boolean): 'removed' | 'retained' => {
      if (!passed || keep) return 'retained';
      // Only this profile's freshly created inode authorizes deletion. The
      // inherited allocator path never grants authority over public journals.
      requireOwnedDirectory(parent, parentIdentity);
      requireOwnedDirectory(directory, identity);
      rmSync(directory, { recursive: true });
      return 'removed';
    },
  };
};

const inheritedFixtureDirectory = (directory: string, cwd: string): string => {
  const reports = join(realpathSync(cwd), 'docs/evidence/deployment-check');
  if (
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    basename(directory) !== 'fixtures' ||
    dirname(dirname(directory)) !== reports ||
    !lstatSync(directory).isDirectory() ||
    realpathSync(directory) !== directory
  )
    throw new Error(`DEPLOYMENT_FIXTURE_PATH_INVALID:${directory}`);
  return directory;
};

export const allocateDeploymentTestFixture = (
  prefix: 'case-' | 'fresh-',
  env = process.env,
  cwd = process.cwd(),
): string => {
  const inherited = env[DEPLOYMENT_TEST_FIXTURES_ENV];
  if (inherited !== undefined) return mkdtempSync(join(inheritedFixtureDirectory(inherited, cwd), prefix));
  // Direct focused tests retain their existing evidence location and lifetime.
  const directory = resolve(cwd, 'docs/evidence/ignition-resume-20261112');
  mkdirSync(directory, { recursive: true });
  return mkdtempSync(join(directory, prefix));
};

export const withDeploymentTestFixtures = async <T>(directory: string, run: () => Promise<T>): Promise<T> => {
  const previous = process.env[DEPLOYMENT_TEST_FIXTURES_ENV];
  process.env[DEPLOYMENT_TEST_FIXTURES_ENV] = directory;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[DEPLOYMENT_TEST_FIXTURES_ENV];
    else process.env[DEPLOYMENT_TEST_FIXTURES_ENV] = previous;
  }
};

type Outcome = Readonly<{ passed: boolean; failure: string | null }>;
type FixtureEvidence = Readonly<{ directory: string; status: 'pending' | 'removed' | 'retained' | 'failed' }>;

export const finishDeploymentTestEvidence = <T extends Outcome>(
  evidence: ReturnType<typeof createDeploymentTestEvidence>,
  result: T,
  write: (result: T & { fixtureEvidence: FixtureEvidence }) => void,
): void => {
  const fixtureEvidence: FixtureEvidence = { directory: evidence.directory, status: 'pending' };
  // Persist the full measured outcome before deleting detail. An interrupted
  // cleanup cannot leave a completed profile result behind.
  evidence.assertReportOwnership();
  write({ ...result, passed: false, fixtureEvidence });
  let status: 'removed' | 'retained';
  try {
    status = evidence.complete(result.passed);
  } catch (error) {
    const failure = `DEPLOYMENT_FIXTURE_CLEANUP_FAILED:${String(error)}`;
    evidence.assertReportOwnership();
    write({ ...result, passed: false, failure, fixtureEvidence: { ...fixtureEvidence, status: 'failed' } });
    throw new Error(failure, { cause: error });
  }
  evidence.assertReportOwnership();
  write({ ...result, fixtureEvidence: { ...fixtureEvidence, status } });
};
