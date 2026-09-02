const CSP_QUOTED_SOURCES = new Set(['self', 'none', 'unsafe-inline']);

/** @type {Readonly<Record<string, readonly string[]>>} */
export const CONTENT_SECURITY_POLICY_DIRECTIVES = Object.freeze({
  'default-src': Object.freeze(['self']),
  'script-src': Object.freeze(['self']),
  'script-src-attr': Object.freeze(['none']),
  'object-src': Object.freeze(['none']),
  'base-uri': Object.freeze(['self']),
  'form-action': Object.freeze(['self']),
  'img-src': Object.freeze(['self', 'data:', 'blob:', 'https:']),
  'media-src': Object.freeze(['self', 'blob:']),
  'font-src': Object.freeze(['self', 'data:']),
  'worker-src': Object.freeze(['self', 'blob:']),
  'connect-src': Object.freeze(['self', 'https:', 'wss:', 'http:', 'ws:']),
  'style-src': Object.freeze(['self', 'unsafe-inline']),
});

/** @param {string} source */
const renderSource = (source) => CSP_QUOTED_SOURCES.has(source) ? `'${source}'` : source;

/** @param {Readonly<Record<string, readonly string[]>>} directives */
export const renderContentSecurityPolicy = (directives) => Object.entries(directives)
  .map(([directive, sources]) => `${directive} ${sources.map(renderSource).join(' ')}`)
  .join('; ');

export const CONTENT_SECURITY_POLICY = renderContentSecurityPolicy(CONTENT_SECURITY_POLICY_DIRECTIVES);
export const CONTENT_SECURITY_POLICY_HTML_ATTRIBUTE = CONTENT_SECURITY_POLICY.replaceAll("'", '&#39;');
