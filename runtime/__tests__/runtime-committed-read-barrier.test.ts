import { describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../runtime';
import {
  acquireRuntimeCommittedRead,
  acquireRuntimeFrameWriter,
  withRuntimeCommittedRead,
} from '../runtime/frame/writer-lock';

describe('runtime committed read barrier', () => {
  test('installs the shared barrier before the first reader on a fresh Runtime', async () => {
    const env = createEmptyEnv('fresh read barrier');
    env.infrastructure = undefined;

    const releaseReader = await acquireRuntimeCommittedRead(env);
    expect(env.infrastructure?.activeCommittedReaders).toBe(1);

    let writerEntered = false;
    const writer = acquireRuntimeFrameWriter(env.infrastructure!).then(release => {
      writerEntered = true;
      return release;
    });
    await Promise.resolve();
    expect(writerEntered).toBeFalse();

    releaseReader();
    const releaseWriter = await writer;
    expect(writerEntered).toBeTrue();
    releaseWriter();
  });

  test('writer waits until every committed reader releases its view', async () => {
    const env = createEmptyEnv('read barrier blocks writer');
    const firstRelease = await acquireRuntimeCommittedRead(env);
    const secondRelease = await acquireRuntimeCommittedRead(env);
    let writerEntered = false;
    const writer = acquireRuntimeFrameWriter(env.infrastructure!).then(release => {
      writerEntered = true;
      return release;
    });

    await Promise.resolve();
    expect(writerEntered).toBeFalse();
    firstRelease();
    await Promise.resolve();
    expect(writerEntered).toBeFalse();

    secondRelease();
    const releaseWriter = await writer;
    expect(writerEntered).toBeTrue();
    releaseWriter();
  });

  test('reader waits for the active writer and then sees committed state', async () => {
    const env = createEmptyEnv('writer blocks read barrier');
    const releaseWriter = await acquireRuntimeFrameWriter(env.infrastructure!);
    let readerEntered = false;
    const reader = acquireRuntimeCommittedRead(env).then(release => {
      readerEntered = true;
      return release;
    });

    await Promise.resolve();
    expect(readerEntered).toBeFalse();
    env.state.height = 7;
    releaseWriter();

    const releaseReader = await reader;
    expect(readerEntered).toBeTrue();
    expect(env.state.height).toBe(7);
    releaseReader();
  });

  test('writers released by the same reader drain remain strictly serialized', async () => {
    const env = createEmptyEnv('reader drain serializes queued writers');
    const releaseReader = await acquireRuntimeCommittedRead(env);
    const entries: string[] = [];
    const firstWriter = acquireRuntimeFrameWriter(env.infrastructure!).then(release => {
      entries.push('first');
      return release;
    });
    const secondWriter = acquireRuntimeFrameWriter(env.infrastructure!).then(release => {
      entries.push('second');
      return release;
    });

    releaseReader();
    const releaseFirst = await firstWriter;
    await Promise.resolve();
    expect(entries).toEqual(['first']);

    releaseFirst();
    const releaseSecond = await secondWriter;
    expect(entries).toEqual(['first', 'second']);
    releaseSecond();
  });

  test('mutated undurable state stays unreadable after a halted writer releases', async () => {
    const env = createEmptyEnv('read barrier rejects damaged state');
    const releaseWriter = await acquireRuntimeFrameWriter(env.infrastructure!);
    env.infrastructure!.stateMutationInFlight = true;
    releaseWriter();

    await expect(acquireRuntimeCommittedRead(env)).rejects.toThrow(
      'RUNTIME_COMMITTED_STATE_UNAVAILABLE_RELOAD_REQUIRED',
    );
  });

  test('scoped committed reads always release their writer fence', async () => {
    const env = createEmptyEnv('scoped read releases fence');
    await expect(withRuntimeCommittedRead(env, () => {
      throw new Error('READ_PROJECTION_FAILED');
    })).rejects.toThrow('READ_PROJECTION_FAILED');

    const releaseWriter = await acquireRuntimeFrameWriter(env.infrastructure!);
    releaseWriter();
  });
});
