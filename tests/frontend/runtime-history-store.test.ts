import { describe, expect, test } from 'bun:test';
import type { RuntimeAdapterViewFrame } from '@xln/runtime/xln-api';
import {
  mergeRuntimeHistoryFrame,
  runtimeHistoryFrameFromViewFrame,
} from '../../frontend/src/lib/stores/runtimeHistoryStore';

const frameAt = (
  height: number,
  entityId = `0x${height}`,
  accounts = 0,
  books = 0,
): RuntimeAdapterViewFrame => ({
  runtimeId: 'h1',
  height,
  head: { latestHeight: height } as RuntimeAdapterViewFrame['head'],
  entities: [],
  activeEntityId: entityId,
  activeEntity: {
    summary: { entityId, label: `E${height}`, height },
    core: {
      entityId,
      signerId: entityId,
      timestamp: height * 1000,
      profile: { name: `E${height}` },
    },
    accounts: {
      items: Array.from({ length: accounts }, (_, index) => ({
        leftEntity: entityId,
        rightEntity: `0xc${index}`,
      })),
      totalItems: accounts,
      pageIndex: 0,
      pageCount: 1,
      nextCursor: null,
      prevCursor: null,
    },
    books: {
      items: Array.from({ length: books }, (_, index) => ({
        pairId: `p${index}`,
        book: { bids: [], asks: [] },
      })),
      totalItems: books,
      pageIndex: 0,
      pageCount: 1,
      nextCursor: null,
      prevCursor: null,
    },
  },
} as RuntimeAdapterViewFrame);

describe('runtime history store', () => {
  test('projects RuntimeAdapterViewFrame into bounded history metadata without Env', () => {
    const item = runtimeHistoryFrameFromViewFrame({
      runtimeId: 'H1',
      mode: 'remote',
      frame: frameAt(12, '0xabc', 2, 3),
    });

    expect(item).toMatchObject({
      runtimeId: 'h1',
      mode: 'remote',
      height: 12,
      timestamp: 12000,
      activeEntityId: '0xabc',
    });
    expect(item.pageInfo).toMatchObject({
      entityId: '0xabc',
      accountsShown: 2,
      accountsTotal: 2,
      booksShown: 3,
      booksTotal: 3,
    });
    expect(item.frame.activeEntity?.accounts.items).toHaveLength(2);
  });

  test('merges by height and keeps the bounded tail', () => {
    const one = runtimeHistoryFrameFromViewFrame({ runtimeId: 'h1', mode: 'remote', frame: frameAt(1) });
    const two = runtimeHistoryFrameFromViewFrame({ runtimeId: 'h1', mode: 'remote', frame: frameAt(2) });
    const replacementTwo = runtimeHistoryFrameFromViewFrame({
      runtimeId: 'h1',
      mode: 'remote',
      frame: frameAt(2, '0xreplacement', 4, 0),
    });
    const three = runtimeHistoryFrameFromViewFrame({ runtimeId: 'h1', mode: 'remote', frame: frameAt(3) });

    const merged = mergeRuntimeHistoryFrame([one, two], replacementTwo, 2);
    const tail = mergeRuntimeHistoryFrame(merged, three, 2);

    expect(merged.map((item) => item.height)).toEqual([1, 2]);
    expect(merged[1]?.activeEntityId).toBe('0xreplacement');
    expect(tail.map((item) => item.height)).toEqual([2, 3]);
    expect(tail[0]?.activeEntityId).toBe('0xreplacement');
  });

  test('does not advertise a phantom next page when totals fit on one page', () => {
    const frame = frameAt(4, '0xsingle', 4, 10);
    frame.activeEntity!.accounts.nextCursor = 'phantom-account-cursor';
    frame.activeEntity!.books.nextCursor = 'phantom-book-cursor';

    const item = runtimeHistoryFrameFromViewFrame({ runtimeId: 'h1', mode: 'remote', frame });

    expect(item.pageInfo?.accountsPageCount).toBe(1);
    expect(item.pageInfo?.booksPageCount).toBe(1);
    expect(item.pageInfo?.accountsHasMore).toBe(false);
    expect(item.pageInfo?.booksHasMore).toBe(false);
  });
});
