import { describe, expect, test } from 'bun:test';
import { resolveRequestClientIp } from '../../../api/server/network/relay-direct';

describe('relay socket boundary', () => {
  test('trusts proxy client headers only from a loopback peer', () => {
    const request = new Request('http://xln.local/relay', {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });

    expect(resolveRequestClientIp(request, '198.51.100.9')).toBe('198.51.100.9');
    expect(resolveRequestClientIp(request, '::ffff:127.0.0.1')).toBe('203.0.113.7');
    expect(resolveRequestClientIp(new Request('http://xln.local/relay', {
      headers: { 'x-forwarded-for': '192.0.2.99, 203.0.113.8' },
    }), '127.0.0.1')).toBe('203.0.113.8');
    expect(resolveRequestClientIp(new Request('http://xln.local/relay', {
      headers: {
        'x-real-ip': '192.0.2.44',
        'cf-connecting-ip': '192.0.2.45',
        'x-forwarded-for': '192.0.2.46, 203.0.113.9',
      },
    }), '127.0.0.1')).toBe('203.0.113.9');
    expect(resolveRequestClientIp(request, null)).toBe('unknown');
  });
});
