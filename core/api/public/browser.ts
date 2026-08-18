/**
 * Browser-only composition root.
 *
 * Production services import `runtime.ts`, whose dependency graph ends at the
 * Runtime/Entity/Account implementation. The browser also needs interactive
 * scenarios, so the bundle composes both surfaces here. Keeping that edge
 * one-way prevents scenarios from becoming dependencies of the financial core.
 */
export * from '../../runtime';
export * from '../../scenarios/browser-api';
