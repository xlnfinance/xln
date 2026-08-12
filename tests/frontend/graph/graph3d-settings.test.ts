import { describe, expect, test } from 'bun:test';

import {
  BIRD_VIEW_SETTINGS_STORAGE_KEY,
  DEFAULT_BIRD_VIEW_SETTINGS,
  buildBirdViewSettings,
  readBirdViewSettings,
  writeBirdViewSettings,
} from '../../../frontend/src/lib/view/panels/graph3d/graph3d-settings';

function memoryStorage(seed?: Record<string, string>) {
  const values = new Map(Object.entries(seed || {}));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    dump: () => Object.fromEntries(values.entries()),
  };
}

describe('graph3d settings', () => {
  test('reads defaults only when storage is empty and rejects invalid JSON', () => {
    expect(readBirdViewSettings(null)).toMatchObject({
      barsMode: 'close',
      selectedTokenId: 1,
      viewMode: '3d',
      entityMode: 'sphere',
      wasLastOpened: false,
      rotationX: 0,
      rotationY: 0,
      rotationZ: 0,
    });

    const storage = memoryStorage({ [BIRD_VIEW_SETTINGS_STORAGE_KEY]: '{bad-json' });
    expect(() => readBirdViewSettings(storage)).toThrow();
  });

  test('rejects malformed stored settings instead of inferring missing fields', () => {
    const storage = memoryStorage({
      [BIRD_VIEW_SETTINGS_STORAGE_KEY]: JSON.stringify({
        barsMode: 'spread',
        selectedTokenId: '2',
        viewMode: '2d',
        entityMode: 'identicon',
        wasLastOpened: true,
      }),
    });

    expect(() => readBirdViewSettings(storage)).toThrow('BIRD_VIEW_SETTINGS_INVALID');
  });

  test('builds and writes camera-aware settings snapshots', () => {
    const storage = memoryStorage();
    const settings = buildBirdViewSettings({
      barsMode: 'close',
      selectedTokenId: 3,
      viewMode: '3d',
      entityMode: 'sphere',
      wasLastOpened: true,
      rotationX: 1,
      rotationY: 2,
      rotationZ: 3,
      camera: {
        position: { x: 10, y: 20, z: 30 },
        target: { x: 1, y: 2, z: 3 },
        zoom: 1.5,
      },
    });

    writeBirdViewSettings(storage, settings);
    expect(JSON.parse(storage.dump()[BIRD_VIEW_SETTINGS_STORAGE_KEY] || '{}')).toEqual(settings);
  });
});
