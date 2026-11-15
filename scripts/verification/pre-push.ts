import { isVerificationBranch, repository, sourceState } from './git';
import { assertCheckEnvironment } from '../../tools/checks/check-environment';
import { verify } from './verify';

export const validateUpdates = (input: string, head: string, branch: string): Readonly<{ base: string }> | null => {
  let update: Readonly<{ base: string }> | null = null;
  for (const line of input.split('\n').filter(Boolean)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length !== 4) throw new Error('VERIFY_PUSH_INPUT_INVALID');
    const [localRef, localOid, remoteRef, remoteOid] = fields;
    if (
      !localRef ||
      !localOid ||
      !remoteRef ||
      !remoteOid ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(localOid) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(remoteOid)
    )
      throw new Error('VERIFY_PUSH_OID_INVALID');
    if (/^0+$/u.test(localOid)) continue;
    // Both branches can share one SHA; HEAD only authorizes the checked-out branch's destination.
    const branchRef = `refs/heads/${branch}`;
    if (!isVerificationBranch(branch) || remoteRef !== branchRef || (localRef !== branchRef && localRef !== 'HEAD')) {
      throw new Error(`VERIFY_PUSH_REQUIRES_CURRENT_BRANCH:branch=${branch}:local=${localRef}:remote=${remoteRef}`);
    }
    if (localOid !== head) throw new Error(`VERIFY_PUSH_REQUIRES_EXACT_HEAD:requested=${localOid}:head=${head}`);
    if (update) throw new Error('VERIFY_PUSH_DUPLICATE_UPDATE');
    update = { base: remoteOid };
  }
  return update;
};

export const prePush = async (cwd: string, input: string): Promise<void> => {
  assertCheckEnvironment();
  const { root } = repository(cwd);
  const before = sourceState(root);
  const update = validateUpdates(input, before.head, before.branch);
  if (!update) return;
  // Git supplies the actual destination OID. A branch name, upstream tracking
  // ref or environment override cannot hide another pending commit from scope.
  const result = await verify(root, update.base);
  if (!result.passed) throw new Error(`VERIFY_PUSH_REJECTED:${result.resultPath}`);
  const after = sourceState(root);
  if (result.before.head !== before.head || after.head !== before.head) throw new Error('VERIFY_PUSH_HEAD_CHANGED');
  if (result.before.branch !== before.branch || after.branch !== before.branch) {
    throw new Error('VERIFY_PUSH_BRANCH_CHANGED');
  }
};

if (import.meta.main) {
  assertCheckEnvironment();
  prePush(process.cwd(), await Bun.stdin.text()).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
