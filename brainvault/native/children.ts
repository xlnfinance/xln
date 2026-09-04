export type NativeChild = Pick<Bun.Subprocess, 'exited' | 'exitCode' | 'kill'>;

const activeNativeChildren = new Set<NativeChild>();

export function trackNativeChild<T extends NativeChild>(child: T): T {
  activeNativeChildren.add(child);
  void child.exited.then(
    () => activeNativeChildren.delete(child),
    () => activeNativeChildren.delete(child),
  );
  return child;
}

export async function terminateNativeChildGroup(group: Iterable<NativeChild>): Promise<void> {
  const children = [...group];
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch {}
  }
  const exited = Promise.allSettled(children.map(child => child.exited));
  await Promise.race([exited, Bun.sleep(250)]);
  for (const child of children) {
    if (child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }
  await exited;
}

export async function terminateNativeChildren(): Promise<void> {
  await terminateNativeChildGroup(activeNativeChildren);
}
