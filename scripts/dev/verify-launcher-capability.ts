#!/usr/bin/env bun
/** Fail before a dev shell can mutate state unless the singleton launched it. */

import { DEV_CAPABILITY_HEADER } from './run-dev';

const portText = process.env['XLN_DEV_LAUNCHER_PORT'] ?? '';
const token = process.env['XLN_DEV_LAUNCHER_TOKEN'] ?? '';
if (!portText || !token) throw new Error('DEV_LAUNCHER_CAPABILITY_MISSING');
const port = Number(portText);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || !/^[0-9a-f]{64}$/.test(token)) {
  throw new Error('DEV_LAUNCHER_CAPABILITY_INVALID');
}

let response: Response;
try {
  response = await fetch(`http://127.0.0.1:${port}/capability`, {
    method: 'POST',
    headers: { [DEV_CAPABILITY_HEADER]: token },
    signal: AbortSignal.timeout(2_000),
  });
} catch (cause) {
  throw new Error('DEV_LAUNCHER_CAPABILITY_UNAVAILABLE', { cause });
}
if (response.status !== 204) throw new Error('DEV_LAUNCHER_CAPABILITY_REJECTED');
