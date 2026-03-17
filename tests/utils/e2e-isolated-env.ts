export function requireIsolatedBaseUrl(name: 'E2E_BASE_URL' | 'E2E_API_BASE_URL'): string {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(
      `${name} is required for isolated e2e. Refusing to fall back to shared https://localhost:8080.`,
    );
  }
  return value;
}
