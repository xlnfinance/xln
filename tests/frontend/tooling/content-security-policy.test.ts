import { describe, expect, test } from 'bun:test';

import {
  CONTENT_SECURITY_POLICY,
  CONTENT_SECURITY_POLICY_DIRECTIVES,
  CONTENT_SECURITY_POLICY_HTML_ATTRIBUTE,
  renderContentSecurityPolicy,
} from '../../../frontend/config/content-security-policy.js';
import { getReactContentSecurityPolicy } from '../../../frontend/config/create-react-app-config';
import svelteConfig from '../../../frontend/svelte.config.js';

describe('frontend content security policy', () => {
  test('keeps Svelte and the React wallet on one canonical directive map', () => {
    expect(svelteConfig.kit.csp?.directives).toBe(CONTENT_SECURITY_POLICY_DIRECTIVES);
    expect(renderContentSecurityPolicy(CONTENT_SECURITY_POLICY_DIRECTIVES)).toBe(CONTENT_SECURITY_POLICY);
    expect(getReactContentSecurityPolicy('wallet')).toBe(CONTENT_SECURITY_POLICY);
    expect(getReactContentSecurityPolicy('site')).toBeNull();
    expect(getReactContentSecurityPolicy('docs')).toBeNull();
    expect(getReactContentSecurityPolicy('ops')).toBeNull();
    expect(CONTENT_SECURITY_POLICY_HTML_ATTRIBUTE).toBe(CONTENT_SECURITY_POLICY.replaceAll("'", '&#39;'));
  });

  test('pins strict script/object policy and the required wallet resource schemes', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("script-src-attr 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("worker-src 'self' blob:");
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self' https: wss: http: ws:");
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
  });
});
