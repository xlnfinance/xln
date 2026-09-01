import { describe, expect, test } from 'bun:test';

import {
  embedBootErrorMessage,
  embedBootTitle,
  parseEmbedBootRequest,
} from '../../../frontend/packages/runtime-client/src/embed-boot-model';
import {
  DEMO_PLAYBACK_INTENT_IDLE,
  createDemoPlaybackIntentStore,
} from '../../../frontend/packages/runtime-client/src/demo-playback-intent';

const url = (raw: string): URL => new URL(raw);

describe('embed boot model', () => {
  test('parses the canonical scenario, autoplay, and speed semantics', () => {
    expect(parseEmbedBootRequest(url('https://xln.test/embed?scenario=ahb'))).toEqual({
      kind: 'scenario', scenario: 'ahb', autoplay: false, speed: 1,
    });
    expect(parseEmbedBootRequest(url('https://xln.test/embed?scenario=%20settle%20&autoplay=1&speed=2'))).toEqual({
      kind: 'scenario', scenario: 'settle', autoplay: true, speed: 2,
    });
    // Autoplay is exactly the string "1"; speed falls back to 1 for absent,
    // unusable, and zero values instead of rejecting the embed.
    expect(parseEmbedBootRequest(url('https://xln.test/embed?scenario=ahb&autoplay=true')).autoplay).toBe(false);
    expect(parseEmbedBootRequest(url('https://xln.test/embed?scenario=ahb&speed=0')).speed).toBe(1);
    expect(parseEmbedBootRequest(url('https://xln.test/embed?scenario=ahb&speed=abc')).speed).toBe(1);
  });

  test('a recorded trail wins over a scenario and needs no runtime', () => {
    const request = parseEmbedBootRequest(url('https://xln.test/embed?scenario=ahb&autoplay=1#trail=eyJmcmFtZXM'));
    expect(request).toEqual({
      kind: 'trail', encodedTrail: 'eyJmcmFtZXM', autoplay: true, speed: 1,
    });
    expect(parseEmbedBootRequest(url('https://xln.test/embed#other=1'))).toEqual({ kind: 'plain' });
    expect(parseEmbedBootRequest(url('https://xln.test/embed'))).toEqual({ kind: 'plain' });
  });

  test('keeps the canonical document title and failure copy', () => {
    expect(embedBootTitle(parseEmbedBootRequest(url('https://xln.test/embed?scenario=ahb')))).toBe('xln — ahb scenario');
    expect(embedBootTitle(parseEmbedBootRequest(url('https://xln.test/embed#trail=e30')))).toBe('xln — Embedded Workspace');
    expect(embedBootTitle(parseEmbedBootRequest(url('https://xln.test/embed')))).toBe('xln — Embedded Workspace');
    expect(embedBootErrorMessage(new Error('NETWORK_TRAIL_VERSION_UNSUPPORTED'))).toBe('NETWORK_TRAIL_VERSION_UNSUPPORTED');
    expect(embedBootErrorMessage('boom')).toBe('boom');
    expect(embedBootErrorMessage('')).toBe('demo failed');
    expect(embedBootErrorMessage(undefined)).toBe('demo failed');
  });
});

describe('demo playback intent store', () => {
  test('normalizes intent and keeps snapshots stable for useSyncExternalStore', () => {
    const store = createDemoPlaybackIntentStore();
    expect(store.getSnapshot()).toBe(DEMO_PLAYBACK_INTENT_IDLE);
    const seen: number[] = [];
    // Store contract: subscribe emits the current value synchronously.
    const unsubscribe = store.subscribe(() => seen.push(1));
    expect(seen).toHaveLength(1);
    store.set({ autoplay: 'yes', speed: 999 } as never);
    expect(store.getSnapshot()).toEqual({ autoplay: false, speed: 10 });
    store.set({ autoplay: false, speed: 10 });
    expect(seen).toHaveLength(2);
    unsubscribe();
    store.set({ speed: 2 });
    expect(seen).toHaveLength(2);
  });

  test('consumes autoplay exactly once', () => {
    const store = createDemoPlaybackIntentStore();
    expect(store.consumeAutoplay()).toBe(false);
    store.set({ autoplay: true, speed: 2 });
    expect(store.consumeAutoplay()).toBe(true);
    expect(store.getSnapshot()).toEqual({ autoplay: false, speed: 2 });
    expect(store.consumeAutoplay()).toBe(false);
    store.reset();
    expect(store.getSnapshot()).toBe(DEMO_PLAYBACK_INTENT_IDLE);
  });
});
