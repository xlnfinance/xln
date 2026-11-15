import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { startStandaloneNode } from './standalone-deployment-support';

type Fixture = Awaited<ReturnType<typeof startStandaloneNode>>;

export const committedDeploymentConfig = async () => {
  const root = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), 'xln-readonly-source-'));
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const archive = execFileSync('git', ['archive', sha, 'core', 'jurisdictions', 'package.json', 'bun.lock'], {
      maxBuffer: 256 * 1024 * 1024,
    });
    execFileSync('tar', ['-x', '-C', directory], { input: archive });
    await symlink(join(root, 'node_modules'), join(directory, 'node_modules'));
    // Compiler writes stay in the export. The source checkout's artifacts/cache
    // must never become writable through the immutable-candidate test fixture.
    for (const name of ['artifacts', 'cache']) {
      await cp(join(root, 'jurisdictions', name), join(directory, 'jurisdictions', name), { recursive: true });
    }
    return {
      sha,
      config: join(directory, 'jurisdictions/hardhat.config.ts'),
      environment: {
        GIT_DIR: execFileSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim(),
        GIT_WORK_TREE: root,
      },
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
};

export const directoryDigests = async (directory: string, prefix = ''): Promise<Record<string, string>> => {
  const entries: Record<string, string> = {};
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(entries, await directoryDigests(directory, path));
    else
      entries[path] = createHash('sha256')
        .update(await readFile(join(directory, path)))
        .digest('hex');
  }
  return entries;
};

export const verifyCli = async (fixture: Fixture, directory = fixture.nativeDirectory, output?: string) => {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    XLN_STACK_MANAGER_RPC_URL: fixture.request.rpcUrl,
    XLN_STACK_MANAGER_CHAIN_ID: '31337',
  };
  delete environment['DEPLOYER_PRIVATE_KEY'];
  delete environment['XLN_DEPLOY_OUTPUT'];
  const child = Bun.spawn(
    [
      'bunx',
      'hardhat',
      'xln-verify',
      '--network',
      'stack-manager',
      '--deployment-dir',
      resolve(directory),
      ...(output ? ['--output', output] : []),
    ],
    {
      cwd: join(process.cwd(), 'jurisdictions'),
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};
