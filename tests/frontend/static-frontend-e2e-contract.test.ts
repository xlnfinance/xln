import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  isStaticFrontendSpecPath,
  parseStaticFrontendSpecs,
  shouldQueryRuntimeIncidents,
} from '../../scripts/testing/static-frontend-e2e-contract';

describe('static frontend E2E contract', () => {
  test('accepts only the runtime-free browser specs', () => {
    expect(parseStaticFrontendSpecs([
      'tests/landing-site.spec.ts',
      'tests/docs-site.spec.ts',
    ])).toEqual([
      'tests/landing-site.spec.ts',
      'tests/docs-site.spec.ts',
    ]);
    expect(() => parseStaticFrontendSpecs([])).toThrow('STATIC_FRONTEND_E2E_SPEC_REQUIRED');
    expect(() => parseStaticFrontendSpecs(['tests/e2e-payment-smoke.spec.ts']))
      .toThrow('STATIC_FRONTEND_E2E_SPEC_NOT_ALLOWED');
    expect(() => parseStaticFrontendSpecs([
      'tests/landing-site.spec.ts',
      'tests/landing-site.spec.ts',
    ])).toThrow('STATIC_FRONTEND_E2E_SPEC_DUPLICATE');
  });

  test('keeps runtime incident checks on except for a static-only run', () => {
    expect(shouldQueryRuntimeIncidents(['@functional'], false)).toBe(true);
    expect(shouldQueryRuntimeIncidents(['@resilience'], false)).toBe(true);
    expect(shouldQueryRuntimeIncidents(['@functional'], true)).toBe(false);
    expect(shouldQueryRuntimeIncidents([], true)).toBe(false);
  });

  test('recognizes only whitelisted spec paths as static', () => {
    expect(isStaticFrontendSpecPath('/repo/tests/docs-site.spec.ts')).toBe(true);
    expect(isStaticFrontendSpecPath('tests/landing-site.spec.ts')).toBe(true);
    expect(isStaticFrontendSpecPath('/repo/tests/e2e-payment-smoke.spec.ts')).toBe(false);
  });

  test('keeps public surfaces independent from remote font hosts', () => {
    const styles = [
      'frontend/src/lib/styles/apple-glass.css',
      'frontend/src/lib/components/Landing/landing-page.css',
    ].map(path => readFileSync(path, 'utf8')).join('\n');
    expect(styles).not.toContain('fonts.googleapis.com');
    expect(styles).not.toContain('fonts.gstatic.com');
  });
});
