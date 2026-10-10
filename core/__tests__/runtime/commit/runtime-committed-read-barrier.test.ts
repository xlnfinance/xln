import { describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../runtime';
import { deriveRuntimeAdapterCapabilityToken } from '../../../api/runtime-adapter/security/auth';
import { decodeRuntimeAdapterBrowserMessage } from '../../../api/runtime-adapter/codec';
import { handleRuntimeAdapterMessage } from '../../../api/runtime-adapter/server';
import {
  acquireRuntimeCommittedRead,
  acquireRuntimeFrameWriter,
  RuntimeCommittedStateUnavailableError,
  withRuntimeCommittedRead,
} from '../../../runtime/frame/lifecycle/writer-lock';
import { toRuntimeAdapterErrorPayload } from '../../../api/runtime-adapter/errors';
import { resolveRuntimeAdapterRead, type RuntimeAdapterResolveContext } from '../../../api/runtime-adapter/resolve';
import { serializeTaggedJson } from '../../../protocol/serialization';

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

  test('the RAdapter classifies the unavailable-state error by type, not by message text', async () => {
    // errors.ts compared error.message to the code; any plain Error carrying
    // that text was answered as a retryable contention.
    const env = createEmptyEnv('typed committed-state unavailable');
    const releaseWriter = await acquireRuntimeFrameWriter(env.infrastructure!);
    env.infrastructure!.stateMutationInFlight = true;
    releaseWriter();
    const typed = await acquireRuntimeCommittedRead(env).catch((error: unknown) => error);
    expect(typed).toBeInstanceOf(RuntimeCommittedStateUnavailableError);
    expect(toRuntimeAdapterErrorPayload(typed)).toMatchObject({ code: 'E_INTERNAL', retryable: true });
    expect(toRuntimeAdapterErrorPayload(new Error('RUNTIME_COMMITTED_STATE_UNAVAILABLE_RELOAD_REQUIRED')))
      .toMatchObject({ code: 'E_INTERNAL', retryable: false });
  });

  test('a nested read inside a held lease never deadlocks behind a queued writer', async () => {
    // The inner acquire waited for the writer queued after the outer read,
    // and that writer waited for the outer read (GET /api/health nested three).
    const env = createEmptyEnv('nested committed read');
    let writerEntered = false;
    let writer: Promise<() => void> | undefined;
    const nested = withRuntimeCommittedRead(env, async () => {
      writer = acquireRuntimeFrameWriter(env.infrastructure!).then(release => {
        writerEntered = true;
        return release;
      });
      await Promise.resolve();
      return withRuntimeCommittedRead(env, () => writerEntered);
    });
    const outcome = await Promise.race([
      nested,
      new Promise<'deadlock'>(resolve => setTimeout(() => resolve('deadlock'), 500)),
    ]);
    expect(outcome).toBe(false);
    const releaseWriter = await writer!;
    expect(writerEntered).toBeTrue();
    releaseWriter();
  });

  test('a payment-route read waiting on gossip never holds the frame writer', async () => {
    // The route search's gossip/relay refresh (up to about 1 s) ran inside
    // the committed-read lease, so any inspect token could stall frames.
    const env = createEmptyEnv('payment routes outside lease');
    const gossip = Promise.withResolvers<{ routes: [] }>();
    const read = resolveRuntimeAdapterRead(
      { env, findPaymentRoutes: () => gossip.promise } as unknown as RuntimeAdapterResolveContext,
      'payment-routes',
    );
    const writer = await Promise.race([
      acquireRuntimeFrameWriter(env.infrastructure!),
      new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 500)),
    ]);
    expect(writer).not.toBe('blocked');
    (writer as () => void)();
    gossip.resolve({ routes: [] });
    expect(await read).toEqual({ routes: [] });
  });

  test('a remote top-up quote may name its funding account', () => {
    const entity = (byte: string) => `0x${byte.repeat(32)}`;
    const query = {
      sourceEntityId: entity('11'),
      targetEntityId: entity('22'),
      fundingAccountId: entity('33'),
      tokenId: 1,
      amount: '5',
    };
    const decoded = decodeRuntimeAdapterBrowserMessage(
      serializeTaggedJson({ v: 1, id: 'quote-1', op: 'read', path: 'payment-routes', query }),
    );
    expect((decoded as { query?: unknown }).query).toEqual(query);
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
