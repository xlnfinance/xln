const STATUS_URL = 'http://127.0.0.1:8080/api/local-pairing/status';
const ISSUE_URL = 'http://127.0.0.1:8080/api/local-pairing/issue';

const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

const responseJson = async (response) => {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload.error || `HTTP_${response.status}`));
  return payload;
};

export const readDaemonStatus = async () => {
  try {
    const response = await fetch(STATUS_URL, { signal: AbortSignal.timeout(1_500), cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
};

export const assertLauncherPortAvailable = async () => {
  try {
    const response = await fetch('http://127.0.0.1:8080/', {
      signal: AbortSignal.timeout(1_500),
      redirect: 'manual',
      cache: 'no-store',
    });
    void response.body?.cancel();
    throw new Error('PORT_8080_IS_NOT_XLND');
  } catch (error) {
    if (error instanceof Error && error.message === 'PORT_8080_IS_NOT_XLND') throw error;
  }
};

export const waitForDaemon = async (timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await readDaemonStatus();
    if (status?.ok && status.ready) return status;
    await sleep(250);
  }
  throw new Error(`XLN_DAEMON_START_TIMEOUT:${timeoutMs}`);
};

export const waitForDaemonStop = async (timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await readDaemonStatus())) return;
    await sleep(100);
  }
  throw new Error(`XLN_DAEMON_STOP_TIMEOUT:${timeoutMs}`);
};

export const issueBrowserPairing = async (controlToken) => {
  const response = await fetch(ISSUE_URL, {
    method: 'POST',
    cache: 'no-store',
    signal: AbortSignal.timeout(5_000),
    headers: { authorization: `Bearer ${controlToken}` },
  });
  const payload = await responseJson(response);
  const pairingToken = String(payload.pairingToken || '').trim();
  if (!pairingToken) throw new Error('LOCAL_PAIRING_TOKEN_MISSING_FROM_DAEMON');
  return pairingToken;
};

export const consumeCliPairing = async (controlToken) => {
  const pairingToken = await issueBrowserPairing(controlToken);
  const response = await fetch('http://localhost:8080/api/local-pairing/consume', {
    method: 'POST',
    cache: 'no-store',
    signal: AbortSignal.timeout(5_000),
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:8080',
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify({ pairingToken }),
  });
  const payload = await responseJson(response);
  const entry = payload?.manifest?.entries?.[0];
  const wsUrl = String(entry?.wsUrl || '').trim();
  const token = String(entry?.token || '').trim();
  if (!wsUrl || !token) throw new Error('XLND_CLI_PAIRING_MANIFEST_INVALID');
  return { wsUrl, token };
};
