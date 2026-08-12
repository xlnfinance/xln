import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const COMPOSE_PATH = join(ROOT, 'ops/blockscout/docker-compose.yml');
const DEPLOY_PATH = join(ROOT, 'scripts/deployment/deploy-blockscout-explorer.sh');

const EXPECTED_IMAGES = [
  'redis:alpine@sha256:978f0e01593e65eed801f2402944efcd936d43b5027e4908a7897baf88ed6241',
  'postgres:17@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317',
  'postgres:17@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317',
  'ghcr.io/blockscout/blockscout:9.0.2@sha256:7659f168e4e2f6b73dd559ae5278fe96ba67bc2905ea01b57a814c68adf5a9dc',
  'ghcr.io/blockscout/frontend:v2.3.5@sha256:4b69f44148414b55c6b8550bc3270c63c9f99e923d54ef0b307e762af6bac90a',
  'nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752',
] as const;

describe('Blockscout deployment image trust', () => {
  test('pins every compose image to the reviewed OCI index digest', () => {
    const compose = readFileSync(COMPOSE_PATH, 'utf8');
    const images = [...compose.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map(match => match[1]!);

    expect(images).toEqual(EXPECTED_IMAGES);
    expect(new Set(images.map(image => image.split('@sha256:')[1])).size).toBe(5);
    for (const image of images) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  test('has no mutable Blockscout tag controls or latest-tag fallback', () => {
    const deploymentSources = [
      readFileSync(COMPOSE_PATH, 'utf8'),
      readFileSync(DEPLOY_PATH, 'utf8'),
    ].join('\n');

    expect(deploymentSources).not.toMatch(/BLOCKSCOUT_(?:BACKEND|FRONTEND)_TAG/);
    expect(deploymentSources).not.toMatch(/(?:^|[:@])latest(?:$|[\s"'}])/m);
  });
});
