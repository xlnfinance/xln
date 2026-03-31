const trim = (value: string | undefined): string => String(value || '').trim();

function requireUrl(label: string, candidates: Array<string | undefined>, detail: string): string {
  for (const candidate of candidates) {
    const value = trim(candidate);
    if (value) return value;
  }
  throw new Error(`${label} is required for e2e. ${detail}`);
}

export function requireAppBaseUrl(): string {
  return requireUrl(
    'APP base URL',
    [process.env.E2E_BASE_URL, process.env.PW_BASE_URL],
    'Refusing to fall back to shared https://localhost:8080.',
  );
}

export function requireApiBaseUrl(): string {
  return requireUrl(
    'API base URL',
    [process.env.E2E_API_BASE_URL, process.env.E2E_BASE_URL, process.env.PW_BASE_URL],
    'Refusing to fall back to shared https://localhost:8080.',
  );
}

export function requireResetBaseUrl(): string {
  return requireUrl(
    'RESET base URL',
    [process.env.E2E_RESET_BASE_URL],
    'Set E2E_RESET_BASE_URL explicitly to the orchestrator host. Refusing to guess from API/app URLs.',
  );
}
