import { expect, test } from 'bun:test';
import { readNativeProgress } from './progress.ts';

function stream(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}

test('native progress protocol separates exact counts from bounded diagnostics', async () => {
  const counts: number[] = [];
  const diagnostic = await readNativeProgress(
    stream('setup note\nBVP1 1\r\nBVP1 40\nBVP1 100\n'),
    completed => counts.push(completed),
  );
  expect(counts).toEqual([1, 40, 100]);
  expect(diagnostic).toBe('setup note');
});

test('native progress protocol rejects malformed or unsafe counters', async () => {
  await expect(readNativeProgress(stream('BVP1 0\n'))).rejects.toThrow('BRAINVAULT_NATIVE_PROGRESS_INVALID');
  await expect(readNativeProgress(stream('BVP1 nope\n'))).rejects.toThrow('BRAINVAULT_NATIVE_PROGRESS_INVALID');
  await expect(readNativeProgress(stream('BVP1 9007199254740992\n'))).rejects.toThrow('BRAINVAULT_NATIVE_PROGRESS_INVALID');
});
