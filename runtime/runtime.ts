/**
 * Public Runtime entrypoint.
 *
 * Keep this file boring: consumers import one stable module while the
 * implementation remains split into reviewable state-machine modules.
 * Key surface: the canonical Runtime composition and public browser/tooling API.
 * Human-audit importance: 82/100 — changing exports can alter every consumer.
 */
export * from './runtime/composition';
export * from './api/public/runtime-public';
