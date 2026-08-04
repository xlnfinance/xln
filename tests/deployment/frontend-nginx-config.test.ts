import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { FRONTEND_ROUTES } from '../../frontend/src/lib/contracts/frontendSurfaces';
import { buildFrontendNginxConfig } from '../../scripts/deployment/frontend-nginx-config';

describe('frontend nginx release config', () => {
  test('covers every contracted route exactly once', () => {
    const config = buildFrontendNginxConfig('/var/www/xln/frontend');
    FRONTEND_ROUTES.forEach(route => {
      expect(config.match(new RegExp(`# route:${route.id}\\n`, 'g'))).toHaveLength(1);
    });
    expect(config).toContain('root /var/www/xln/frontend/current/site;');
    expect(config).toContain('root /var/www/xln/frontend/current/docs;');
    expect(config).toContain('root /var/www/xln/frontend/current/wallet;');
    expect(config).toContain('root /var/www/xln/frontend/current/ops;');
    for (const surface of ['site', 'docs', 'wallet', 'ops']) {
      expect(config).toContain(`location ^~ /assets-${surface}/ {`);
    }
  });

  test('exposes build identities and rejects a cross-surface fallback', () => {
    const config = buildFrontendNginxConfig('/var/www/xln/frontend');
    expect(config).toContain('location = /.well-known/xln-build/wallet.json');
    expect(config).toContain('location / { return 404; }');
    expect(config).not.toContain('/index.html;\n    }\n\n    # No universal');
    expect(config).toContain('location = /admin { return 308 /health; }');
    expect(config).toContain('location = /radapter { return 308 /app; }');
  });

  test('rejects unsafe release roots', () => {
    expect(() => buildFrontendNginxConfig('../frontend')).toThrow('FRONTEND_NGINX_ROOT_INVALID');
    expect(() => buildFrontendNginxConfig('/var/www/../escape')).toThrow('FRONTEND_NGINX_ROOT_INVALID');
  });

  test('repository nginx example consumes the generated atomic-release include', () => {
    const example = readFileSync('frontend/nginx-example.conf', 'utf8');
    expect(example).toContain('include /etc/nginx/snippets/xln-frontend-release.conf;');
    expect(example).not.toContain('root /var/www/xln/frontend/build;');
    expect(example).not.toContain('try_files $uri $uri.html $uri/ /index.html;');
  });
});
