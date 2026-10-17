import { expect, test } from 'bun:test';
import { configureWalletNginx } from './configure-wallet-nginx';

const fragment = '/root/xln/scripts/deployment/nginx-wallet.conf';
const site = `server {
    listen 443 ssl;
    server_name xln.finance app.xln.finance;
    ssl_certificate /operator/cert.pem;
    ssl_certificate_key /operator/key.pem;
    add_header Strict-Transport-Security "max-age=31536000" always;
    location = /app {
        root /root/xln/frontend/build;
        try_files /index.html =404;
    }
    location /api/ { proxy_pass http://127.0.0.1:8080; }
    location /relay { proxy_pass http://127.0.0.1:8080; }
}
server {
    server_name custody.xln.finance;
    location / { proxy_pass http://127.0.0.1:8087; }
}
`;

test('adds exactly the canonical wallet include without changing TLS, API, relay or other hosts', () => {
  const configured = configureWalletNginx(site, fragment);
  const include = `    include "${fragment}";\n\n`;
  expect(configured.replace(include, '')).toBe(site);
  expect(configured.split(include)).toHaveLength(2);
  expect(configured.indexOf(include)).toBeLessThan(configured.indexOf('    location = /app'));
  expect(configureWalletNginx(configured, fragment)).toBe(configured);
});

test('rejects a competing wallet or worker owner instead of adding duplicate locations', () => {
  for (const route of ['location /ui/', 'location = /ui', 'location ^~ /ui/', 'location = /account-worker.js']) {
    const competing = site.replace('    location = /app', `    ${route} { return 404; }\n    location = /app`);
    expect(() => configureWalletNginx(competing, fragment)).toThrow('NGINX_WALLET_CONFLICTING_ROUTE');
  }
});

test('rejects ambiguous or misowned sites and include injection', () => {
  expect(() => configureWalletNginx(site + site, fragment)).toThrow('NGINX_WALLET_CANONICAL_SITE_REQUIRED');
  expect(() =>
    configureWalletNginx(site.replace('xln.finance app.xln.finance', 'different.example'), fragment),
  ).toThrow('NGINX_WALLET_CANONICAL_SITE_REQUIRED');
  const wrong = site
    .replace('    location = /app', '    location = /old-app')
    .replace(
      '    server_name custody.xln.finance;',
      '    server_name custody.xln.finance;\n    location = /app { return 404; }',
    );
  expect(() => configureWalletNginx(wrong, fragment)).toThrow('NGINX_WALLET_WRONG_SERVER');
  expect(() => configureWalletNginx(site, '/tmp/include"; injected on;')).toThrow('NGINX_WALLET_INVALID_INCLUDE_PATH');
  const misowned = site.replace(
    '    server_name custody.xln.finance;',
    `    server_name custody.xln.finance;\n    include "${fragment}";\n`,
  );
  expect(() => configureWalletNginx(misowned, fragment)).toThrow('NGINX_WALLET_WRONG_INCLUDE_OWNER');
});
