const FILTERED_LINES = new Set([
  'Run npm run preview to preview your production build locally.',
]);

type OutputWriter = (chunk: string) => void | Promise<void>;

export const filterViteBuildCheckLine = (line: string): string | null =>
  FILTERED_LINES.has(line.trimEnd()) ? null : line;

const streamFilteredOutput = async (
  stream: ReadableStream<Uint8Array> | null,
  write: OutputWriter,
): Promise<void> => {
  if (!stream) return;
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let pending = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const filtered = filterViteBuildCheckLine(line);
      if (filtered !== null) await write(`${filtered}\n`);
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) {
    const filtered = filterViteBuildCheckLine(pending);
    if (filtered !== null) await write(filtered);
  }
};

const run = async (): Promise<void> => {
  const proc = Bun.spawn(['bunx', 'vite', 'build'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await Promise.all([
    streamFilteredOutput(proc.stdout, (chunk) => Bun.stdout.write(chunk)),
    streamFilteredOutput(proc.stderr, (chunk) => Bun.stderr.write(chunk)),
  ]);
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
};

if (import.meta.main) {
  run().catch((error) => {
    console.error('vite build check failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
