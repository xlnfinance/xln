import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function configureWalletNginx(source: string, fragment: string): string {
  if (/[";\r\n]/.test(fragment)) throw new Error('NGINX_WALLET_INVALID_INCLUDE_PATH');
  const server = '    server_name xln.finance app.xln.finance;';
  const app = '    location = /app {';
  const include = `    include "${fragment}";\n\n`;
  if (source.split(server).length !== 2 || source.split(app).length !== 2) {
    throw new Error('NGINX_WALLET_CANONICAL_SITE_REQUIRED');
  }
  const start = source.indexOf(server);
  const next = source.indexOf('\nserver {', start);
  const end = next === -1 ? source.length : next;
  const appIndex = source.indexOf(app);
  if (appIndex < start || appIndex >= end) throw new Error('NGINX_WALLET_WRONG_SERVER');
  const site = source.slice(start, end);
  if (/location\s+(?:(?:=|\^~)\s+)?\/(?:ui(?:\/|\s)|account-worker\.js\s)/.test(site)) {
    throw new Error('NGINX_WALLET_CONFLICTING_ROUTE');
  }
  if (source.includes(include)) {
    if (source.split(include).length !== 2 || !site.includes(include)) {
      throw new Error('NGINX_WALLET_WRONG_INCLUDE_OWNER');
    }
    return source;
  }
  return source.replace(app, include + app);
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error('NGINX_WALLET_SITE_PATH_REQUIRED');
  const source = readFileSync(path, 'utf8');
  const configured = configureWalletNginx(source, join(import.meta.dir, 'nginx-wallet.conf'));
  if (configured !== source) writeFileSync(path, configured);
}
