import { describe, expect, test } from 'bun:test';

import { installFrontendReleaseInclude } from '../../scripts/deployment/nginx-site-release-include';

const LEGACY_SITE = `server {
    listen 443 ssl http2;
    server_name xln.finance;
    root /root/xln/frontend/build;

    location = /app {
        try_files /index.html =404;
    }

    location /_app/ {
        expires 1y;
    }

    location / {
        try_files $uri $uri.html /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8080;
    }
}

server {
    listen 80;
    server_name xln.finance;
    return 301 https://$host$request_uri;
}
`;

describe('nginx atomic frontend include installer', () => {
  test('removes only legacy frontend locations from the HTTPS server', () => {
    const transformed = installFrontendReleaseInclude(LEGACY_SITE);
    expect(transformed).toContain('include /etc/nginx/snippets/xln-frontend-release.conf;');
    expect(transformed).toContain('location /api/ {');
    expect(transformed).toContain('return 301 https://$host$request_uri;');
    expect(transformed).not.toContain('location = /app {');
    expect(transformed).not.toContain('location /_app/ {');
    expect(transformed).not.toContain('try_files $uri $uri.html /index.html;');
    expect(transformed).not.toContain('root /root/xln/frontend/build;');
  });

  test('is idempotent and rejects ambiguous production servers', () => {
    const transformed = installFrontendReleaseInclude(LEGACY_SITE);
    expect(installFrontendReleaseInclude(transformed)).toBe(transformed);
    expect(() => installFrontendReleaseInclude(`${LEGACY_SITE}\n${LEGACY_SITE}`))
      .toThrow('FRONTEND_NGINX_PRODUCTION_SERVER_INVALID:2');
  });

  test('rejects a path-unsafe include', () => {
    expect(() => installFrontendReleaseInclude(LEGACY_SITE, '../frontend.conf'))
      .toThrow('FRONTEND_NGINX_INCLUDE_PATH_INVALID');
  });
});
