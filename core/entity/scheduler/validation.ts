import {
  FinancialDataCorruptionError,
  validateMapInstance,
  validateNumber,
  validateObject,
  validateString,
} from '../../protocol/boundary/validation-primitives';
import type {
  CrontabState,
  CrontabTaskMethod,
  CrontabTaskState,
  ScheduledHook,
  ScheduledHookType,
} from './types';
import {
  EntityCollectionCandidateMap,
  isPersistentEntityCollectionMap,
} from '../state/persistent-collection-map';

const isTaskMethod = (value: unknown): value is CrontabTaskMethod =>
  value === 'hubRebalance';

const isHookType = (value: unknown): value is ScheduledHookType =>
  value === 'dispute_deadline' ||
  value === 'settlement_window' ||
  value === 'watchdog' ||
  value === 'hub_rebalance_kick' ||
  value === 'board_hanko_refresh' ||
  value === 'counterparty_board_hanko_refresh_deadline' ||
  value === 'cross_j_orderbook_sweep';

const rejectUnexpectedKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new FinancialDataCorruptionError(
        `${context} has unexpected key "${key}"`,
      );
    }
  }
};

const validateTask = (value: unknown, context: string): CrontabTaskState => {
  const task = validateObject(value, context);
  if (!isTaskMethod(task['method'])) {
    throw new FinancialDataCorruptionError(`${context}.method is unknown`);
  }
  validateNumber(task['intervalMs'], `${context}.intervalMs`);
  validateNumber(task['lastRun'], `${context}.lastRun`);
  if (typeof task['enabled'] !== 'boolean') {
    throw new FinancialDataCorruptionError(`${context}.enabled must be boolean`);
  }
  const params = validateObject(task['params'], `${context}.params`);
  for (const [key, parameter] of Object.entries(params)) {
    if (
      typeof parameter !== 'string' &&
      typeof parameter !== 'number' &&
      typeof parameter !== 'boolean'
    ) {
      throw new FinancialDataCorruptionError(
        `${context}.params.${key} must be scalar`,
      );
    }
  }
  return {
    method: task['method'],
    intervalMs: task['intervalMs'] as number,
    lastRun: task['lastRun'] as number,
    enabled: task['enabled'],
    params: params as CrontabTaskState['params'],
  };
};

const validateBoardHankoRefreshData = (
  data: Record<string, unknown>,
  context: string,
): Extract<ScheduledHook, { type: 'board_hanko_refresh' }>['data'] => {
  rejectUnexpectedKeys(
    data,
    ['activationJHeight', 'activationLogIndex', 'afterCounterpartyId'],
    context,
  );
  const activationJHeight = validateNumber(
    data['activationJHeight'],
    `${context}.activationJHeight`,
  );
  const activationLogIndex = validateNumber(
    data['activationLogIndex'],
    `${context}.activationLogIndex`,
  );
  if (
    !Number.isSafeInteger(activationJHeight) ||
    activationJHeight < 1 ||
    !Number.isSafeInteger(activationLogIndex) ||
    activationLogIndex < 0
  ) {
    throw new FinancialDataCorruptionError(
      `${context} board activation position is invalid`,
    );
  }
  const afterCounterpartyId = data['afterCounterpartyId'];
  if (typeof afterCounterpartyId !== 'string') {
    throw new FinancialDataCorruptionError(
      `${context}.afterCounterpartyId must be string`,
    );
  }
  return {
    activationJHeight,
    activationLogIndex,
    // Empty means "start before the first canonical Account"; it is a cursor,
    // not an Entity ID, so a non-empty identifier guard would reject genesis.
    afterCounterpartyId,
  };
};

const validateCounterpartyBoardHankoRefreshDeadlineData = (
  data: Record<string, unknown>,
  context: string,
): Extract<ScheduledHook, { type: 'counterparty_board_hanko_refresh_deadline' }>['data'] => {
  rejectUnexpectedKeys(
    data,
    ['accountId', 'activationJHeight', 'activationLogIndex'],
    context,
  );
  const accountId = validateString(data['accountId'], `${context}.accountId`);
  const activationJHeight = validateNumber(
    data['activationJHeight'],
    `${context}.activationJHeight`,
  );
  const activationLogIndex = validateNumber(
    data['activationLogIndex'],
    `${context}.activationLogIndex`,
  );
  if (
    !Number.isSafeInteger(activationJHeight) || activationJHeight < 1 ||
    !Number.isSafeInteger(activationLogIndex) || activationLogIndex < 0
  ) {
    throw new FinancialDataCorruptionError(
      `${context} counterparty board activation position is invalid`,
    );
  }
  return { accountId, activationJHeight, activationLogIndex };
};

const validateHookData = (
  type: ScheduledHookType,
  data: Record<string, unknown>,
  context: string,
): ScheduledHook['data'] => {
  switch (type) {
    case 'dispute_deadline':
      rejectUnexpectedKeys(data, ['accountId'], context);
      return {
        accountId: validateString(data['accountId'], `${context}.accountId`),
      };
    case 'settlement_window':
    case 'watchdog':
      rejectUnexpectedKeys(data, [], context);
      return {};
    case 'hub_rebalance_kick':
      rejectUnexpectedKeys(data, ['reason', 'counterpartyId'], context);
      return {
        reason: validateString(data['reason'], `${context}.reason`),
        counterpartyId: validateString(
          data['counterpartyId'],
          `${context}.counterpartyId`,
        ),
      };
    case 'board_hanko_refresh':
      return validateBoardHankoRefreshData(data, context);
    case 'counterparty_board_hanko_refresh_deadline':
      return validateCounterpartyBoardHankoRefreshDeadlineData(data, context);
    case 'cross_j_orderbook_sweep':
      rejectUnexpectedKeys(data, ['reason'], context);
      return {
        reason: validateString(data['reason'], `${context}.reason`),
      };
  }
};

const validateHook = (value: unknown, context: string): ScheduledHook => {
  const hook = validateObject(value, context);
  const id = validateString(hook['id'], `${context}.id`);
  const triggerAt = validateNumber(hook['triggerAt'], `${context}.triggerAt`);
  const type = hook['type'];
  if (!isHookType(type)) {
    throw new FinancialDataCorruptionError(`${context}.type is unknown`);
  }
  const data = validateHookData(
    type,
    validateObject(hook['data'], `${context}.data`),
    `${context}.data`,
  );
  return { id, triggerAt, type, data } as ScheduledHook;
};

function assertCrontabState(
  state: Record<string, unknown>,
  context: string,
): asserts state is Record<string, unknown> & CrontabState {
  const tasks = validateMapInstance(state['tasks'], `${context}.tasks`);
  const hooks = state['hooks'];
  if (
    !(hooks instanceof Map) &&
    !(hooks instanceof EntityCollectionCandidateMap) &&
    !isPersistentEntityCollectionMap(hooks)
  ) {
    throw new FinancialDataCorruptionError(`${context}.hooks must be a canonical Map or Patricia map`);
  }
  for (const [taskKey, taskValue] of tasks) {
    if (!isTaskMethod(taskKey)) {
      throw new FinancialDataCorruptionError(`${context}.tasks key is unknown`);
    }
    const task = validateTask(taskValue, `${context}.tasks[${String(taskKey)}]`);
    if (task.method !== taskKey) {
      throw new FinancialDataCorruptionError(
        `${context}.tasks[${String(taskKey)}].method must match task key`,
      );
    }
  }
  for (const [hookId, hookValue] of hooks) {
    if (typeof hookId !== 'string' || hookId.length === 0) {
      throw new FinancialDataCorruptionError(
        `${context}.hooks key must be non-empty string`,
      );
    }
    const hook = validateHook(hookValue, `${context}.hooks[${hookId}]`);
    if (hook.id !== hookId) {
      throw new FinancialDataCorruptionError(
        `${context}.hooks[${hookId}].id must match hook key`,
      );
    }
  }
}

export const validateCrontabState = (
  value: unknown,
  context: string,
): CrontabState => {
  const state = validateObject(value, context);
  assertCrontabState(state, context);
  return state;
};
