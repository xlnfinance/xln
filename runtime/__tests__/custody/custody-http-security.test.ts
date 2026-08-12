import { expect, test } from 'bun:test';

import { rejectUnsafeCustodyMutation } from '../../../custody/http-security';

const request = (headers: Record<string, string>, url = 'https://custody.xln.finance/api/withdraw'): Request => new Request(
  url,
  { method: 'POST', headers, body: '{}' },
);

test('custody mutation accepts only same-origin JSON', () => {
  expect(rejectUnsafeCustodyMutation(request({
    origin: 'https://custody.xln.finance',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json; charset=utf-8',
  }))).toBeNull();
  expect(rejectUnsafeCustodyMutation(request({
    origin: 'https://evil.xln.finance',
    'content-type': 'application/json',
  }))).toEqual({ status: 403, code: 'CUSTODY_ORIGIN_FORBIDDEN' });
  expect(rejectUnsafeCustodyMutation(request({
    origin: 'https://custody.xln.finance',
    'sec-fetch-site': 'same-site',
    'content-type': 'application/json',
  }))).toEqual({ status: 403, code: 'CUSTODY_FETCH_SITE_FORBIDDEN' });
  expect(rejectUnsafeCustodyMutation(request({
    origin: 'https://custody.xln.finance',
    'content-type': 'text/plain',
  }))).toEqual({ status: 415, code: 'CUSTODY_JSON_REQUIRED' });
});

test('custody mutation trusts the deployment proxy protocol only from loopback', () => {
  const proxied = request({
    origin: 'https://custody.xln.finance',
    'x-forwarded-proto': 'https',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  }, 'http://custody.xln.finance/api/withdraw');
  expect(rejectUnsafeCustodyMutation(proxied, '127.0.0.1')).toBeNull();
  expect(rejectUnsafeCustodyMutation(proxied, '203.0.113.7')).toEqual({
    status: 403,
    code: 'CUSTODY_ORIGIN_FORBIDDEN',
  });
});
