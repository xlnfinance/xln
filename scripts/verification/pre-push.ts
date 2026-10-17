import { repository, sourceState } from './git';
import { verify } from './verify';

export const validateUpdates = (input: string, head: string): boolean => {
  let checksRequired = false;
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
    if (remoteRef !== 'refs/heads/main' || (localRef !== 'refs/heads/main' && localRef !== 'HEAD')) {
      throw new Error(`VERIFY_PUSH_REQUIRES_MAIN:local=${localRef}:remote=${remoteRef}`);
    }
    if (localOid !== head) throw new Error(`VERIFY_PUSH_REQUIRES_EXACT_HEAD:requested=${localOid}:head=${head}`);
    checksRequired = true;
  }
  return checksRequired;
};

export const prePush = async (cwd: string, input: string): Promise<void> => {
  const { root } = repository(cwd);
  const head = sourceState(root).head;
  if (!validateUpdates(input, head)) return;
  const result = await verify(root);
  if (!result.passed) throw new Error(`VERIFY_PUSH_REJECTED:${result.resultPath}`);
  if (sourceState(root).head !== head) throw new Error('VERIFY_PUSH_HEAD_CHANGED');
};

if (import.meta.main) {
  prePush(process.cwd(), await Bun.stdin.text()).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
