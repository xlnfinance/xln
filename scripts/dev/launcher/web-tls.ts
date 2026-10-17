import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** The same local certificate selection owns Vite, boot links and repeat probes. */
export const selectDevWebTls = (
  repoRoot: string,
  forceHttp = process.env['XLN_VITE_FORCE_HTTP'] === '1',
): { certPath: string; keyPath: string } | null => {
  if (forceHttp) return null;
  for (const base of ['frontend/localhost+3', 'frontend/localhost+2', '192.168.1.23+2']) {
    const certPath = resolve(repoRoot, base + '.pem');
    const keyPath = resolve(repoRoot, base + '-key.pem');
    if (existsSync(certPath) && existsSync(keyPath)) return { certPath, keyPath };
  }
  return null;
};

if (import.meta.main) {
  console.log(selectDevWebTls(resolve(import.meta.dir, '../../..')) ? 'https' : 'http');
}
