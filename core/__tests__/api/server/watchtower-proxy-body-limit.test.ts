import { describe, expect, test } from 'bun:test';
import {
  API_MAX_BODY_BYTES,
  WATCHTOWER_PROXY_MAX_BODY_BYTES,
  WATCHTOWER_PROXY_PATH,
  oversizedBodyResponse,
} from '../../../api/server/rpc/watchtower-proxy';

const post = (length: number): Request =>
  new Request('http://127.0.0.1/x', { method: 'POST', headers: { 'content-length': String(length) } });

describe('server body limits', () => {
  test('a wallet backup larger than 1 MiB reaches the tower proxy', () => {
    // Regression: a fresh wallet backup of 1,102,884 bytes was cut at the server's former 1 MiB cap.
    expect(oversizedBodyResponse(post(1_102_884), WATCHTOWER_PROXY_PATH)).toBeNull();
    expect(oversizedBodyResponse(post(WATCHTOWER_PROXY_MAX_BODY_BYTES), WATCHTOWER_PROXY_PATH)).toBeNull();
  });

  test('the proxy still refuses more than the tower quota plus its envelope', () => {
    expect(oversizedBodyResponse(post(WATCHTOWER_PROXY_MAX_BODY_BYTES + 1), WATCHTOWER_PROXY_PATH)?.status).toBe(413);
  });

  test('every other route keeps the ordinary 1 MiB limit', () => {
    expect(oversizedBodyResponse(post(API_MAX_BODY_BYTES), '/api/faucet/offchain')).toBeNull();
    expect(oversizedBodyResponse(post(API_MAX_BODY_BYTES + 1), '/api/faucet/offchain')?.status).toBe(413);
    expect(oversizedBodyResponse(post(1_102_884), '/rpc')?.status).toBe(413);
  });
});
