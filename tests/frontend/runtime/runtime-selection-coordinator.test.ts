import { expect, test } from 'bun:test';
import { coordinateRuntimeSelection } from '../../../frontend/src/lib/stores/runtimeStore';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

test('global Runtime selection is one-writer and only the latest queued intent runs', async () => {
  const releaseFirst = deferred<void>();
  const firstStarted = deferred<void>();
  const events: string[] = [];

  const first = coordinateRuntimeSelection(async () => {
    events.push('first:start');
    firstStarted.resolve();
    await releaseFirst.promise;
    events.push('first:end');
    return 'first';
  });
  await firstStarted.promise;

  const skippedMiddle = coordinateRuntimeSelection(async () => {
    events.push('middle');
    return 'middle';
  });
  const latest = coordinateRuntimeSelection(async () => {
    events.push('latest');
    return 'latest';
  });

  releaseFirst.resolve();
  expect(await first).toBeNull();
  expect(await skippedMiddle).toBeNull();
  expect(await latest).toBe('latest');
  expect(events).toEqual(['first:start', 'first:end', 'latest']);
});
