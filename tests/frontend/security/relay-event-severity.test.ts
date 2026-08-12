import { describe, expect, test } from 'bun:test';
import {
  isRelayTimelineError,
  isRelayTimelineWarning,
  relayTimelineTone,
} from '../../../frontend/src/lib/health/relayEventSeverity';

describe('relay event severity', () => {
  test('uses typed delivery metadata', () => {
    expect(relayTimelineTone({
      status: 'delivered',
      delivery: {
        outcome: 'failed',
        retryable: true,
        fatal: false,
        terminal: false,
      },
    })).toBe('warning');

    expect(isRelayTimelineError({
      status: 'queued',
      delivery: {
        outcome: 'failed',
        retryable: false,
        fatal: true,
        terminal: true,
      },
    })).toBe(true);

    expect(isRelayTimelineWarning({
      delivery: {
        outcome: 'deferred',
        retryable: true,
        fatal: false,
        terminal: false,
      },
    })).toBe(true);
  });

  test('classifies current activity status when delivery metadata is absent', () => {
    expect(relayTimelineTone({ status: 'rejected' })).toBe('error');
    expect(relayTimelineTone({ status: 'queued' })).toBe('warning');
    expect(relayTimelineTone({ status: 'delivered' })).toBe('neutral');
  });

});
