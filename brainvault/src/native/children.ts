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

/** Native workers receive only the small environment their wire protocol needs. */
export function nativeChildEnvironment(
  overrides: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const key of ['PATH', 'TMPDIR'] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!/^BRAINVAULT_[A-Z0-9_]+$/.test(key)) {
      throw new Error('BRAINVAULT_NATIVE_ENV_INVALID');
    }
    environment[key] = value;
  }
  return environment;
}

/** Read no more than the exact protocol output allocation. */
export async function readNativeOutput(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error('BRAINVAULT_NATIVE_OUTPUT_LIMIT_INVALID');
  }
  const reader = stream.getReader();
  const output = Buffer.alloc(maximumBytes);
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return output.subarray(0, offset);
      if (offset + value.length > maximumBytes) {
        throw new Error('BRAINVAULT_NATIVE_STDOUT_LIMIT');
      }
      output.set(value, offset);
      offset += value.length;
    }
  } catch (error) {
    output.fill(0);
    try { await reader.cancel(); } catch {}
    throw error;
  }
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
