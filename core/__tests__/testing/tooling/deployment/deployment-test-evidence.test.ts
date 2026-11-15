import { afterEach, expect, test } from 'bun:test';
import { safeStringify } from '../../../../protocol/serialization';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allocateDeploymentTestFixture,
  createDeploymentTestEvidence,
  DEPLOYMENT_TEST_FIXTURES_ENV,
  finishDeploymentTestEvidence,
  withDeploymentTestFixtures,
} from '../../../../../tools/deployment/test-evidence';

const temporary: string[] = [];
const modulePath = fileURLToPath(new URL('../../../../../tools/deployment/test-evidence.ts', import.meta.url));
afterEach(() => temporary.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

const fixture = (keep = '') => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'xln-deployment-test-evidence-')));
  temporary.push(root);
  const reports = join(root, 'docs/evidence/deployment-check');
  mkdirSync(reports, { recursive: true });
  const report = mkdtempSync(join(reports, 'run-'));
  const env: NodeJS.ProcessEnv = { ...process.env, XLN_KEEP_TEST_ARTIFACTS: keep };
  const evidence = createDeploymentTestEvidence(report, env);
  const publicDirectory = join(root, 'jurisdictions/ignition/deployments/public-attempt');
  mkdirSync(publicDirectory, { recursive: true });
  writeFileSync(join(publicDirectory, 'journal.jsonl'), 'public-native-journal');
  return { root, reports, report, evidence, env, publicDirectory };
};

type Fixture = ReturnType<typeof fixture>;
const childRun = (context: Fixture, ending = '', timeout = 5_000) =>
  spawnSync(
    process.execPath,
    [
      '-e',
      [
        `import { allocateDeploymentTestFixture } from ${safeStringify(modulePath)};`,
        "import { writeFileSync } from 'node:fs';",
        "for (const prefix of ['case-', 'fresh-']) {",
        '  const directory = allocateDeploymentTestFixture(prefix);',
        '  writeFileSync(`${directory}/proof.json`, JSON.stringify({ prefix }));',
        '}',
        ending,
      ].join('\n'),
    ],
    {
      cwd: context.root,
      env: { ...context.env, [DEPLOYMENT_TEST_FIXTURES_ENV]: context.evidence.directory },
      encoding: 'utf8',
      timeout,
    },
  );

const persist = (context: Fixture, passed: boolean, failure: string | null = null) => {
  const path = join(context.report, 'result.json');
  finishDeploymentTestEvidence(context.evidence, { passed, failure }, result =>
    writeFileSync(path, safeStringify(result)),
  );
  return JSON.parse(readFileSync(path, 'utf8'));
};

test('a successful child run removes only its own fixtures after recording the measured outcome', () => {
  const context = fixture();
  const foreign = join(context.reports, 'another-run/fixtures/native/journal.jsonl');
  mkdirSync(dirname(foreign), { recursive: true });
  writeFileSync(foreign, 'foreign-test-journal');
  const usdc = join(context.root, 'docs/evidence/usdc-public-roundtrip.json');
  writeFileSync(usdc, 'public-usdc-report');
  const child = childRun(context);
  expect({ status: child.status, signal: child.signal, stderr: child.stderr }).toEqual({
    status: 0,
    signal: null,
    stderr: '',
  });
  // Existing Inspector coverage creates symlinked executables. Removal may
  // unlink such entries, but must never traverse into their public target.
  symlinkSync(context.publicDirectory, join(context.evidence.directory, 'public-link'));
  const observed: Array<{ passed: boolean; status: string; fixturesExist: boolean }> = [];
  finishDeploymentTestEvidence(context.evidence, { passed: true, failure: null }, result => {
    writeFileSync(join(context.report, 'result.json'), safeStringify(result));
    observed.push({
      passed: result.passed,
      status: result.fixtureEvidence.status,
      fixturesExist: existsSync(context.evidence.directory),
    });
  });
  expect(observed).toEqual([
    { passed: false, status: 'pending', fixturesExist: true },
    { passed: true, status: 'removed', fixturesExist: false },
  ]);
  expect(readFileSync(foreign, 'utf8')).toBe('foreign-test-journal');
  expect(readFileSync(join(context.publicDirectory, 'journal.jsonl'), 'utf8')).toBe('public-native-journal');
  expect(readFileSync(usdc, 'utf8')).toBe('public-usdc-report');
});

test.each([
  { name: 'failed', ending: 'process.exit(7);', timeout: 5_000 },
  { name: 'signaled', ending: "process.kill(process.pid, 'SIGTERM');", timeout: 5_000 },
  { name: 'timed out', ending: 'setInterval(() => {}, 1000);', timeout: 1_000 },
])('retains the complete fixtures from a $name child run', ({ name, ending, timeout }) => {
  const context = fixture();
  const child = childRun(context, ending, timeout);
  if (name === 'failed') expect(child.status).toBe(7);
  else expect(child.signal).toBe('SIGTERM');
  const passed = child.status === 0 && child.signal === null && child.error === undefined;
  const result = persist(context, passed, `CHILD_${name}`);
  expect(result.passed).toBe(false);
  expect(result.fixtureEvidence.status).toBe('retained');
  expect(existsSync(context.evidence.directory)).toBe(true);
});

test.each(['1', ' true ', 'YES'])('explicit XLN_KEEP_TEST_ARTIFACTS=%s retains successful new fixtures', keep => {
  const context = fixture(keep);
  expect(childRun(context).status).toBe(0);
  const result = persist(context, true);
  expect(result.passed).toBe(true);
  expect(result.fixtureEvidence.status).toBe('retained');
  expect(existsSync(context.evidence.directory)).toBe(true);
});

test('an otherwise successful child cannot delete evidence when source identity rejects its candidate', () => {
  const context = fixture();
  expect(childRun(context).status).toBe(0);
  const result = persist(context, false, 'DEPLOYMENT_SOURCE_CHANGED_DURING_CHECK');
  expect(result.failure).toBe('DEPLOYMENT_SOURCE_CHANGED_DURING_CHECK');
  expect(result.fixtureEvidence.status).toBe('retained');
  expect(existsSync(context.evidence.directory)).toBe(true);
});

test('failure to persist the measured outcome leaves all fixture detail intact', () => {
  const context = fixture();
  expect(childRun(context).status).toBe(0);
  // A real filesystem error: the result path is already a directory.
  const path = join(context.report, 'result.json');
  mkdirSync(path);
  expect(() =>
    finishDeploymentTestEvidence(context.evidence, { passed: true, failure: null }, result => {
      writeFileSync(path, safeStringify(result));
    }),
  ).toThrow();
  expect(existsSync(context.evidence.directory)).toBe(true);
});

test('a replaced fixture root fails loudly and durably without deleting the public journal', () => {
  const context = fixture();
  const original = `${context.evidence.directory}-retained`;
  renameSync(context.evidence.directory, original);
  symlinkSync(context.publicDirectory, context.evidence.directory);
  expect(() => persist(context, true)).toThrow('DEPLOYMENT_FIXTURE_CLEANUP_FAILED');
  const result = JSON.parse(readFileSync(join(context.report, 'result.json'), 'utf8'));
  expect(result.passed).toBe(false);
  expect(result.failure).toContain('DEPLOYMENT_FIXTURE_OWNERSHIP_LOST');
  expect(result.fixtureEvidence.status).toBe('failed');
  expect(existsSync(original)).toBe(true);
  expect(readFileSync(join(context.publicDirectory, 'journal.jsonl'), 'utf8')).toBe('public-native-journal');
});

test.each([
  { name: 'successful', passed: true, keep: '' },
  { name: 'failed', passed: false, keep: '' },
  { name: 'explicitly retained', passed: true, keep: '1' },
])('a replaced report parent cannot overwrite public evidence for a $name run', ({ passed, keep }) => {
  const context = fixture(keep);
  const original = `${context.report}-retained`;
  const publicResult = join(context.publicDirectory, 'result.json');
  writeFileSync(publicResult, 'public-result-sentinel');
  renameSync(context.report, original);
  symlinkSync(context.publicDirectory, context.report);
  expect(() => persist(context, passed)).toThrow('DEPLOYMENT_FIXTURE_OWNERSHIP_LOST');
  expect(readFileSync(publicResult, 'utf8')).toBe('public-result-sentinel');
  expect(existsSync(join(original, 'fixtures'))).toBe(true);
  expect(readFileSync(join(context.publicDirectory, 'journal.jsonl'), 'utf8')).toBe('public-native-journal');
});

test.each([
  { name: 'cleanup failure diagnostic', passed: true, keep: '' },
  { name: 'failed outcome', passed: false, keep: '' },
  { name: 'kept outcome', passed: true, keep: '1' },
])('report ownership is rechecked before writing the $name', ({ passed, keep }) => {
  const context = fixture(keep);
  const original = `${context.report}-retained`;
  const publicResult = join(context.publicDirectory, 'result.json');
  writeFileSync(publicResult, 'public-result-sentinel');
  let writes = 0;
  expect(() =>
    finishDeploymentTestEvidence(context.evidence, { passed, failure: null }, result => {
      writeFileSync(join(context.report, 'result.json'), safeStringify(result));
      writes++;
      renameSync(context.report, original);
      symlinkSync(context.publicDirectory, context.report);
    }),
  ).toThrow('DEPLOYMENT_FIXTURE_OWNERSHIP_LOST');
  expect(writes).toBe(1);
  expect(readFileSync(publicResult, 'utf8')).toBe('public-result-sentinel');
  expect(JSON.parse(readFileSync(join(original, 'result.json'), 'utf8')).passed).toBe(false);
  expect(existsSync(join(original, 'fixtures'))).toBe(true);
});

test('an existing fixture subtree cannot be adopted by another profile owner', () => {
  const context = fixture();
  expect(() => createDeploymentTestEvidence(context.report, context.env)).toThrow();
  expect(existsSync(context.evidence.directory)).toBe(true);
});

test('ownership cannot be acquired through a report-directory symlink', () => {
  const context = fixture();
  const linkedReport = join(context.reports, 'linked-report');
  symlinkSync(context.publicDirectory, linkedReport);
  expect(() => createDeploymentTestEvidence(linkedReport, context.env)).toThrow('DEPLOYMENT_FIXTURE_OWNERSHIP_LOST');
  expect(existsSync(join(context.publicDirectory, 'fixtures'))).toBe(false);
});

test('an inherited public or noncanonical path is refused before allocating local test evidence', () => {
  const context = fixture();
  for (const directory of [context.publicDirectory, 'fixtures', `${context.report}/../another-run/fixtures`]) {
    expect(() =>
      allocateDeploymentTestFixture(
        'case-',
        {
          [DEPLOYMENT_TEST_FIXTURES_ENV]: directory,
        },
        context.root,
      ),
    ).toThrow('DEPLOYMENT_FIXTURE_PATH_INVALID');
  }
  // Mutating the inherited allocator environment never transfers delete authority.
  context.env[DEPLOYMENT_TEST_FIXTURES_ENV] = context.publicDirectory;
  expect(context.evidence.complete(true)).toBe('removed');
  expect(readFileSync(join(context.publicDirectory, 'journal.jsonl'), 'utf8')).toBe('public-native-journal');
});

test('direct focused allocation keeps its existing evidence location and lifetime', () => {
  const context = fixture();
  const directory = allocateDeploymentTestFixture('case-', {}, context.root);
  expect(dirname(directory)).toBe(join(context.root, 'docs/evidence/ignition-resume-20261112'));
  expect(context.evidence.complete(true)).toBe('removed');
  expect(existsSync(directory)).toBe(true);
});

test('profile fixture routing restores the inherited environment after success and failure', async () => {
  const context = fixture();
  const previous = process.env[DEPLOYMENT_TEST_FIXTURES_ENV];
  await withDeploymentTestFixtures(context.evidence.directory, async () => {
    expect(process.env[DEPLOYMENT_TEST_FIXTURES_ENV]).toBe(context.evidence.directory);
    expect(childRun(context).status).toBe(0);
  });
  expect(process.env[DEPLOYMENT_TEST_FIXTURES_ENV]).toBe(previous);
  await expect(
    withDeploymentTestFixtures(context.evidence.directory, async () => {
      const child = childRun(context, 'process.exit(7);');
      if (child.status !== 0) throw new Error('CHILD_REJECTED');
    }),
  ).rejects.toThrow('CHILD_REJECTED');
  expect(process.env[DEPLOYMENT_TEST_FIXTURES_ENV]).toBe(previous);
});
