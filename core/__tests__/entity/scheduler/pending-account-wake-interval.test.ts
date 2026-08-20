import { describe, expect, test } from 'bun:test';

import {
  ACCOUNT_PENDING_RESEND_AFTER_MS,
  crontabTaskDueAt,
  initCrontab,
} from '../../../entity/scheduler';
import { collectDueScheduledWakeJobs } from '../../../runtime/mempool/scheduled-wake';
import { getPendingAccountIds } from '../../../entity/consensus/account/work-index';
import {
  commitEntityFrameCandidateState,
  createEntityFrameCandidateState,
} from '../../../entity/state-clone';
import { getEntityAccountForWrite } from '../../../entity/state/persistent-account-map';
import {
  entity,
  makeJurisdiction,
  makeState,
} from '../../helpers/cross-j';

describe('pending Account wake interval', () => {
  test('crontab resend clock is the pending-frame wake, not the 10s generic slot', () => {
    const self = entity('11');
    const counterparty = entity('22');
    const state = {
      ...makeState(
        self,
        'validator',
        makeJurisdiction('pending-wake-interval', 31_337, 'aa', 'bb'),
        counterparty,
      ),
      crontabState: initCrontab(),
    };
    const candidate = createEntityFrameCandidateState(state);
    const account = getEntityAccountForWrite(candidate.accounts, counterparty);
    if (!account) throw new Error('TEST_ACCOUNT_WRITE_SHELL_MISSING');
    account.pendingFrame = {
      ...account.currentFrame,
      height: 1,
      timestamp: 0,
      accountTxs: [],
    };
    const committed = commitEntityFrameCandidateState(candidate);
    expect([...getPendingAccountIds(committed)]).toEqual([counterparty]);
    const task = committed.crontabState?.tasks.get('maintainPendingAccounts');
    if (!task) throw new Error('TEST_PENDING_MAINTENANCE_TASK_MISSING');
    expect(crontabTaskDueAt(task)).toBe(ACCOUNT_PENDING_RESEND_AFTER_MS);
    expect(collectDueScheduledWakeJobs(committed, ACCOUNT_PENDING_RESEND_AFTER_MS, true)).toEqual([
      {
        kind: 'task',
        id: 'maintainPendingAccounts',
        dueAt: ACCOUNT_PENDING_RESEND_AFTER_MS,
      },
    ]);
  });
});
