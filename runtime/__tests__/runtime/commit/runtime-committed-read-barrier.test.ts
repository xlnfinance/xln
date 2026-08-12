import { describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../runtime';
import { deriveRuntimeAdapterCapabilityToken } from '../../../api/runtime-adapter/security/auth';
import { decodeRuntimeAdapterBrowserMessage } from '../../../api/runtime-adapter/codec';
import { handleRuntimeAdapterMessage } from '../../../api/runtime-adapter/server';
import {
  acquireRuntimeCommittedRead,
  acquireRuntimeFrameWriter,
  withRuntimeCommittedRead,
} from '../../../runtime/frame/lifecycle/writer-lock';

const radapterAuthSeed = process.env['XLN_RADAPTER_AUTH_SEED'] || 'seed';
process.env['XLN_RADAPTER_AUTH_SEED'] = radapterAuthSeed;

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

  test('a queued writer blocks later readers until its frame is released', async () => {
    const env = createEmptyEnv('queued writer has reader priority');
    const releaseFirstReader = await acquireRuntimeCommittedRead(env);
    let writerEntered = false;
    const writer = acquireRuntimeFrameWriter(env.infrastructure!).then(release => {
      writerEntered = true;
      return release;
    });
    await Promise.resolve();

    let secondReaderEntered = false;
    const secondReader = acquireRuntimeCommittedRead(env).then(release => {
      secondReaderEntered = true;
      return release;
    });
    await Promise.resolve();
    expect(secondReaderEntered).toBeFalse();

    releaseFirstReader();
    const releaseWriter = await writer;
    expect(writerEntered).toBeTrue();
    expect(secondReaderEntered).toBeFalse();

    releaseWriter();
    const releaseSecondReader = await secondReader;
    expect(secondReaderEntered).toBeTrue();
    releaseSecondReader();
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

  test('Runtime adapter commands cannot inspect or mutate an in-flight frame', async () => {
    const env = createEmptyEnv('adapter committed read barrier');
    env.infrastructure!.lifecyclePhase = 'running';
    env.infrastructure!.loopActive = true;
    const responses: string[] = [];
    const socket = {
      send: (message: string | Uint8Array) => {
        responses.push(String(message));
      },
    };
    let enqueued = 0;
    const deps = {
      enqueueRuntimeInput: () => {
        enqueued += 1;
      },
    };

    await handleRuntimeAdapterMessage(
      socket,
      {
        v: 1,
        id: 'auth-committed-read',
        op: 'auth',
        key: deriveRuntimeAdapterCapabilityToken(
          radapterAuthSeed,
          'full',
          Date.now() + 60_000,
          {
            audience: env.runtimeId!,
            tokenId: 'commit-barrier-token',
          },
        ),
        challenge: `0x${'41'.repeat(32)}`,
      },
      env,
      deps,
    );
    expect(decodeRuntimeAdapterBrowserMessage(responses.pop()!)).toMatchObject({
      ok: true,
      payload: { authLevel: 'admin' },
    });
    responses.length = 0;

    env.infrastructure!.stateMutationInFlight = true;
    await handleRuntimeAdapterMessage(
      socket,
      {
        v: 1,
        id: 'send-during-mutation',
        op: 'send',
        commandId: 'commit-barrier-command-0001',
        commandSequence: 1,
        input: { runtimeTxs: [], entityInputs: [] },
      },
      env,
      deps,
    );
    expect(decodeRuntimeAdapterBrowserMessage(responses.pop()!)).toMatchObject({
      ok: false,
      error: { code: 'E_INTERNAL' },
    });
    expect(enqueued).toBe(0);

    env.infrastructure!.stateMutationInFlight = false;
    await handleRuntimeAdapterMessage(
      socket,
      {
        v: 1,
        id: 'send-after-commit',
        op: 'send',
        commandId: 'commit-barrier-command-0001',
        commandSequence: 1,
        input: { runtimeTxs: [], entityInputs: [] },
      },
      env,
      deps,
    );
    expect(decodeRuntimeAdapterBrowserMessage(responses.pop()!)).toMatchObject({
      ok: true,
      payload: { status: 'pending' },
    });
    expect(enqueued).toBe(1);
  });
});
