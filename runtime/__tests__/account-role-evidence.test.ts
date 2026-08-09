import { expect, test } from 'bun:test';

import {
  canonicalAccountRoleEvidence,
  defaultAccountDisputeConfigForRoleEvidence,
} from '../account/dispute-config';

const USER = `0x${'11'.repeat(32)}`;
const HUB = `0x${'22'.repeat(32)}`;

test('account clocks bind one explicit role authority per party', () => {
  expect(defaultAccountDisputeConfigForRoleEvidence(
    { entityId: USER, isHub: false, source: 'committed-profile' },
    { entityId: HUB, isHub: true, source: 'verified-gossip-profile' },
    new Map([[USER, false]]),
  )).toEqual({ leftResponseSeconds: 86_400, rightResponseSeconds: 3_600 });
});

test('available committed role vetoes conflicting gossip authority', () => {
  expect(() => canonicalAccountRoleEvidence(
    { entityId: HUB, isHub: true, source: 'verified-gossip-profile' },
    HUB,
    false,
  )).toThrow(`ACCOUNT_ROLE_EVIDENCE_COMMITTED_CONFLICT:${HUB}`);
});

test('committed authority cannot be asserted without committed state', () => {
  expect(() => canonicalAccountRoleEvidence(
    { entityId: USER, isHub: false, source: 'committed-profile' },
    USER,
  )).toThrow(`ACCOUNT_ROLE_EVIDENCE_COMMITTED_MISSING:${USER}`);
});
