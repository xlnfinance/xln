const PROGRESS_PREFIX = 'BVP1 ';
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

export const BRAINVAULT_NATIVE_PROGRESS_ENV = 'BRAINVAULT_NATIVE_PROGRESS';

/** Read an opt-in native stderr stream without mixing progress with diagnostics. */
export async function readNativeProgress(
  stream: ReadableStream<Uint8Array>,
  onProgress?: (completed: number) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let diagnostic = '';

  const acceptLine = (line: string) => {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (clean.startsWith(PROGRESS_PREFIX)) {
      if (!/^BVP1 [1-9][0-9]*$/.test(clean)) throw new Error('BRAINVAULT_NATIVE_PROGRESS_INVALID');
      const completed = Number(clean.slice(PROGRESS_PREFIX.length));
      if (!Number.isSafeInteger(completed)) throw new Error('BRAINVAULT_NATIVE_PROGRESS_INVALID');
      onProgress?.(completed);
      return;
    }
    if (diagnostic.length < MAX_DIAGNOSTIC_BYTES) {
      diagnostic += `${clean}\n`.slice(0, MAX_DIAGNOSTIC_BYTES - diagnostic.length);
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline === -1) break;
      acceptLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  }
  pending += decoder.decode();
  if (pending !== '') acceptLine(pending);
  return diagnostic.trim();
}
