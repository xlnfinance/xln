/**
 * What a narrated step lights up.
 *
 * A cue with `focusEntityIds` / `focusAccountIds` names the parties the narration is about;
 * everything else dims. A cue without focus — or no cue — clears the dimming. Whatever the
 * step actually moved stays lit even when the cue does not name it: motion on a dimmed
 * entity would read as a rendering fault, not as emphasis.
 */

import type { NetworkMachineCue } from '../networkMachine';
import type { NetworkStepMotion } from './networkStepMotion';

export type NetworkCueFocus = {
  key: string;
  entityIds: ReadonlySet<string>;
  /** Canonical `left:right` account ids, left being the lexicographically lower entity. */
  accountIds: ReadonlySet<string>;
  /**
   * The cue named parties but no account (an on-chain submission, a reserve top-up): their
   * accounts and counterparties stay lit, since the account is what the step is about.
   */
  includeEntityAccounts: boolean;
};

export const canonicalAccountId = (first: string, second: string): string => {
  const [left, right] = [first.toLowerCase(), second.toLowerCase()].sort();
  return `${left}:${right}`;
};

const motionAccountIds = (motion: NetworkStepMotion | null): string[] =>
  (motion?.flows ?? []).map((flow) => canonicalAccountId(flow.fromEntityId, flow.toEntityId));

const motionEntityIds = (motion: NetworkStepMotion | null): string[] => [
  ...(motion?.flows ?? []).flatMap((flow) => [flow.fromEntityId, flow.toEntityId]),
  ...(motion?.pulses ?? []).map((pulse) => pulse.entityId),
  ...(motion?.jSubmissions ?? []),
];

export const resolveNetworkCueFocus = (
  cue: NetworkMachineCue | null,
  motion: NetworkStepMotion | null,
): NetworkCueFocus | null => {
  const namedEntities = cue?.focusEntityIds ?? [];
  const namedAccounts = (cue?.focusAccountIds ?? []).map((accountId) => {
    const [first = '', second = ''] = accountId.split(':');
    return canonicalAccountId(first, second);
  });
  if (!cue || (namedEntities.length === 0 && namedAccounts.length === 0)) return null;
  const accountIds = new Set([...namedAccounts, ...motionAccountIds(motion)]);
  const entityIds = new Set([
    ...namedEntities.map((entityId) => entityId.toLowerCase()),
    ...namedAccounts.flatMap((accountId) => accountId.split(':')),
    ...motionEntityIds(motion),
  ]);
  const key = `${cue.id}|${[...entityIds].sort().join(',')}|${[...accountIds].sort().join(',')}`;
  return { key, entityIds, accountIds, includeEntityAccounts: namedAccounts.length === 0 };
};
