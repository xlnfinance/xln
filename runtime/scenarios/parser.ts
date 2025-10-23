/**
 * XLN Scenario Parser
 *
 * Parses human-readable .scenario.txt files into structured Scenario objects
 */

import {
  Scenario,
  ScenarioEvent,
  ScenarioAction,
  ActionParam,
  RepeatBlock,
  ParserContext,
  ParsedScenario,
  ScenarioError,
  ScenarioWarning,
  ViewState,
  parseRange,
  expandRange,
  parseNamedParam,
} from './types.js';

/**
 * Parse scenario text into structured Scenario object
 */
export function parseScenario(text: string): ParsedScenario {
  const lines = text.split('\n');
  const errors: ScenarioError[] = [];
  const warnings: ScenarioWarning[] = [];

  const context: ParserContext = {
    currentTimestamp: 0,
    currentDescription: [],
    currentActions: [],
    lineNumber: 0,
    inRepeatBlock: false,
    repeatBlockActions: [],
  };

  const events: ScenarioEvent[] = [];
  const repeatBlocks: RepeatBlock[] = [];
  const includes: string[] = [];
  let seed = '';

  for (let i = 0; i < lines.length; i++) {
    context.lineNumber = i + 1;
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.trim();

    // Skip empty lines
    if (trimmed === '') continue;

    // Skip comments
    if (trimmed.startsWith('#')) continue;

    // Frame separator
    if (trimmed === '===') {
      flushCurrentEvent(context, events);
      continue;
    }

    // SEED declaration
    if (trimmed.startsWith('SEED ')) {
      seed = trimmed.substring(5).trim();
      continue;
    }

    // INCLUDE directive
    if (trimmed.startsWith('INCLUDE ')) {
      const includePath = trimmed.substring(8).trim();
      includes.push(includePath);
      // TODO: Actually load and merge included scenarios
      warnings.push({
        lineNumber: context.lineNumber,
        message: 'INCLUDE directive parsed but not yet implemented',
        suggestion: 'Included scenarios will be merged in future implementation',
      });
      continue;
    }

    // REPEAT block start
    if (trimmed.startsWith('REPEAT ')) {
      const intervalStr = trimmed.substring(7).trim();
      const interval = parseFloat(intervalStr);

      if (isNaN(interval) || interval <= 0) {
        errors.push({
          lineNumber: context.lineNumber,
          message: `Invalid REPEAT interval: ${intervalStr}`,
        });
        continue;
      }

      context.inRepeatBlock = true;
      context.repeatInterval = interval;
      context.repeatStartTimestamp = context.currentTimestamp;
      context.repeatBlockActions = [];
      continue;
    }

    // REPEAT block end
    if (trimmed === 'END_REPEAT') {
      if (!context.inRepeatBlock) {
        errors.push({
          lineNumber: context.lineNumber,
          message: 'END_REPEAT without matching REPEAT',
        });
        continue;
      }

      if (context.repeatInterval !== undefined && context.repeatStartTimestamp !== undefined) {
        repeatBlocks.push({
          interval: context.repeatInterval,
          actions: context.repeatBlockActions,
          startTimestamp: context.repeatStartTimestamp,
          sourceLineNumber: context.lineNumber,
        });
      }

      context.inRepeatBlock = false;
      delete context.repeatInterval;
      delete context.repeatStartTimestamp;
      context.repeatBlockActions = [];
      continue;
    }

    // Timestamp line (e.g., "5: Title here" or "5.5:")
    const timestampMatch = trimmed.match(/^(\d+(?:\.\d+)?):(.*)$/);
    if (timestampMatch) {
      flushCurrentEvent(context, events);

      const timestampStr = timestampMatch[1];
      const titlePart = timestampMatch[2];
      if (!timestampStr) continue;

      context.currentTimestamp = parseFloat(timestampStr);
      const titleText = titlePart?.trim();
      if (titleText && titleText.length > 0) {
        context.currentTitle = titleText;
      } else {
        delete context.currentTitle;
      }
      context.currentDescription = [];
      context.currentActions = [];
      delete context.currentViewState;
      continue;
    }

    // Action line or description
    const actionResult = parseActionLine(trimmed, context.lineNumber);

    if (actionResult.isAction) {
      // parseActionLine may return multiple actions due to range expansion
      const actions = actionResult.actions || [actionResult.action!];

      // Add all expanded actions to appropriate context
      if (context.inRepeatBlock) {
        context.repeatBlockActions.push(...actions);
      } else {
        context.currentActions.push(...actions);
      }
    } else if (actionResult.error) {
      errors.push(actionResult.error);
    } else {
      // It's a description line
      if (context.currentActions.length === 0 && !context.inRepeatBlock) {
        context.currentDescription.push(trimmed);
      } else {
        warnings.push({
          lineNumber: context.lineNumber,
          message: 'Text after actions is ignored',
          suggestion: 'Place descriptions before actions in the same timestamp block',
        });
      }
    }
  }

  // Flush final event
  flushCurrentEvent(context, events);

  // Check for unclosed REPEAT block
  if (context.inRepeatBlock) {
    errors.push({
      lineNumber: context.lineNumber,
      message: 'Unclosed REPEAT block (missing END_REPEAT)',
    });
  }

  const scenario: Scenario = {
    seed,
    events,
    repeatBlocks,
    includes,
  };

  return { scenario, errors, warnings };
}

/**
 * Flush current accumulated event to events array
 */
function flushCurrentEvent(
  context: ParserContext,
  events: ScenarioEvent[]
): void {
  if (context.currentActions.length > 0) {
    const descText = context.currentDescription.join('\n').trim();

    const event: ScenarioEvent = {
      timestamp: context.currentTimestamp,
      actions: context.currentActions,
    };

    if (context.currentTitle !== undefined) {
      event.title = context.currentTitle;
    }
    if (descText.length > 0) {
      event.description = descText;
    }
    if (context.currentViewState !== undefined) {
      event.viewState = context.currentViewState;
    }

    events.push(event);

    delete context.currentTitle;
    context.currentDescription = [];
    context.currentActions = [];
    delete context.currentViewState;
  }
}

/**
 * Parse a single action line
 */
function parseActionLine(
  line: string,
  lineNumber: number
): { isAction: boolean; action?: ScenarioAction; actions?: ScenarioAction[]; error?: ScenarioError } {
  const tokens = line.split(/\s+/);

  if (tokens.length === 0) {
    return { isAction: false };
  }

  const firstToken = tokens[0];
  if (!firstToken) {
    return { isAction: false };
  }

  // Special actions without entity ID (keywords)
  const KEYWORDS = ['VIEW', 'import', 'PAUSE', 'ASSERT', 'grid', 'payRandom', 'r2r'];

  // Check if this looks like an action:
  // 1. Starts with keyword (VIEW, import, etc.)
  // 2. Starts with entity ID (number or range like "2" or "3..5")
  const isKeyword = KEYWORDS.includes(firstToken);
  const isEntityId = /^\d+$/.test(firstToken) || /^\d+\.\.\d+$/.test(firstToken);

  if (!isKeyword && !isEntityId) {
    // Not an action, probably a description line
    return { isAction: false };
  }

  // VIEW state
  if (firstToken === 'VIEW') {
    const viewState: ViewState = {};

    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token) continue;

      const param = parseNamedParam(token);
      if (!param) {
        return {
          isAction: false,
          error: {
            lineNumber,
            message: `Invalid VIEW parameter: ${token}`,
          },
        };
      }

      const { key, value } = param;

      if (key === 'camera') {
        if (!['orbital', 'overview', 'follow', 'free'].includes(value)) {
          return {
            isAction: false,
            error: {
              lineNumber,
              message: `Invalid camera mode: ${value}`,
            },
          };
        }
        viewState.camera = value as 'orbital' | 'overview' | 'follow' | 'free';
      } else if (key === 'zoom') {
        viewState.zoom = parseFloat(value);
      } else if (key === 'focus') {
        viewState.focus = value;
      } else if (key === 'panel') {
        viewState.panel = value as 'accounts' | 'transactions' | 'consensus' | 'network';
      } else if (key === 'speed') {
        viewState.speed = parseFloat(value);
      }
    }

    return {
      isAction: true,
      action: {
        type: 'VIEW',
        params: [viewState],
        sourceLineNumber: lineNumber,
      },
    };
  }

  // IMPORT entities
  if (firstToken === 'import') {
    const rangeOrId = tokens[1];
    if (!rangeOrId) {
      return {
        isAction: false,
        error: {
          lineNumber,
          message: 'import requires entity ID or range',
        },
      };
    }

    const range = parseRange(rangeOrId);
    const entityIds = range ? expandRange(range).map(String) : [rangeOrId];

    // Parse position parameters (x=, y=, z=)
    const additionalParams = tokens.slice(2);
    const position: Record<string, string> = {};

    for (const param of additionalParams) {
      const parsed = parseNamedParam(param);
      if (parsed) {
        position[parsed.key] = parsed.value;
      }
    }

    // Build params array with entity IDs and optional position
    const params: ActionParam[] = [...entityIds];
    if (Object.keys(position).length > 0) {
      params.push(position);
    }

    return {
      isAction: true,
      action: {
        type: 'import',
        params,
        sourceLineNumber: lineNumber,
      },
    };
  }

  // GRID command (no entity prefix)
  if (firstToken === 'grid') {
    const allParams = tokens.slice(1);
    const params: ActionParam[] = [];

    for (const param of allParams) {
      const parsed = parseNamedParam(param);
      if (parsed) {
        params.push({ [parsed.key]: parsed.value });
      } else {
        params.push(param);
      }
    }

    return {
      isAction: true,
      action: {
        type: 'grid',
        params,
        sourceLineNumber: lineNumber,
      },
    };
  }

  // PAYRANDOM command (no entity prefix)
  if (firstToken === 'payRandom') {
    const allParams = tokens.slice(1);
    const params: ActionParam[] = [];

    for (const param of allParams) {
      const parsed = parseNamedParam(param);
      if (parsed) {
        params.push({ [parsed.key]: parsed.value });
      } else {
        params.push(param);
      }
    }

    return {
      isAction: true,
      action: {
        type: 'payRandom',
        params,
        sourceLineNumber: lineNumber,
      },
    };
  }

  // R2R command (reserve-to-reserve transfer)
  // Format: r2r <fromEntityIndex> <toEntityIndex> <amount>
  if (firstToken === 'r2r') {
    const fromEntity = tokens[1];
    const toEntity = tokens[2];
    const amount = tokens[3];

    if (!fromEntity || !toEntity || !amount) {
      return {
        isAction: false,
        error: {
          lineNumber,
          message: 'r2r requires 3 parameters: fromEntity toEntity amount',
        },
      };
    }

    return {
      isAction: true,
      action: {
        type: 'r2r',
        params: [fromEntity, toEntity, amount],
        sourceLineNumber: lineNumber,
      },
    };
  }

  // Fund command (add reserves to entity)
  // Format: fund <entityIndex> <amount>
  if (firstToken === 'fund') {
    const entityIndex = tokens[1];
    const amount = tokens[2];

    if (!entityIndex || !amount) {
      return {
        isAction: false,
        error: {
          lineNumber,
          message: 'fund requires 2 parameters: entityIndex amount',
        },
      };
    }

    return {
      isAction: true,
      action: {
        type: 'fund',
        params: [entityIndex, amount],
        sourceLineNumber: lineNumber,
      },
    };
  }

  // Regular action with entity ID
  const entityIdOrRange = firstToken;
  const actionType = tokens[1];

  if (!actionType || !entityIdOrRange) {
    // Not an action, probably a description line
    return { isAction: false };
  }

  // Parse entity ID (could be range)
  const entityRange = parseRange(entityIdOrRange);
  const entityIds = entityRange ? expandRange(entityRange).map(String) : [entityIdOrRange];

  // Parse action parameters (remaining tokens)
  const actionParams = tokens.slice(2);

  // Expand ranges in parameters for cartesian product
  const expandedActions: ScenarioAction[] = [];

  for (const entityId of entityIds) {
    const expandedParams = expandParamsWithRanges(actionParams);

    for (const params of expandedParams) {
      expandedActions.push({
        type: actionType,
        entityId,
        params,
        sourceLineNumber: lineNumber,
      });
    }
  }

  // Return all expanded actions
  if (expandedActions.length === 0) {
    return { isAction: false };
  }

  const firstAction = expandedActions[0];
  if (!firstAction) {
    return { isAction: false };
  }

  if (expandedActions.length === 1) {
    return { isAction: true, action: firstAction };
  }

  // Multiple actions due to range expansion
  return { isAction: true, actions: expandedActions };
}

/**
 * Expand parameters containing ranges into cartesian product
 * Example: ["1..2", "foo"] -> [["1", "foo"], ["2", "foo"]]
 */
function expandParamsWithRanges(params: string[]): (string | Record<string, string>)[][] {
  const expandedSets: (string | Record<string, string>)[][] = [];

  for (const param of params) {
    const namedParam = parseNamedParam(param);

    if (namedParam) {
      // Named parameter (key=value)
      expandedSets.push([{ [namedParam.key]: namedParam.value }]);
    } else {
      // Check if it's a range
      const range = parseRange(param);
      if (range) {
        expandedSets.push(expandRange(range).map(String));
      } else {
        expandedSets.push([param]);
      }
    }
  }

  // Compute cartesian product
  return cartesianProduct(expandedSets);
}

/**
 * Compute cartesian product of arrays
 */
function cartesianProduct<T>(arrays: T[][]): T[][] {
  if (arrays.length === 0) return [[]];

  const firstArray = arrays[0];
  if (!firstArray) return [[]];
  if (arrays.length === 1) return firstArray.map(x => [x]);

  const [first, ...rest] = arrays;
  if (!first) return [[]];

  const restProduct = cartesianProduct(rest);

  const result: T[][] = [];
  for (const item of first) {
    for (const restItems of restProduct) {
      result.push([item, ...restItems]);
    }
  }

  return result;
}

/**
 * Expand repeat blocks into explicit events
 * Called during scenario execution to generate events at specific timestamps
 */
export function expandRepeatBlocks(
  scenario: Scenario,
  maxTimestamp: number
): ScenarioEvent[] {
  const expandedEvents: ScenarioEvent[] = [];

  for (const repeatBlock of scenario.repeatBlocks) {
    let currentTime = repeatBlock.startTimestamp;

    while (currentTime <= maxTimestamp) {
      expandedEvents.push({
        timestamp: currentTime,
        actions: repeatBlock.actions,
        title: `[REPEAT every ${repeatBlock.interval}s]`,
      });

      currentTime += repeatBlock.interval;
    }
  }

  return expandedEvents;
}

/**
 * Merge scenario events (explicit + repeat blocks) and sort by timestamp
 */
export function mergeAndSortEvents(scenario: Scenario, maxTimestamp: number): ScenarioEvent[] {
  const repeatEvents = expandRepeatBlocks(scenario, maxTimestamp);
  const allEvents = [...scenario.events, ...repeatEvents];

  // Sort by timestamp, stable sort preserves order for same timestamp
  return allEvents.sort((a, b) => a.timestamp - b.timestamp);
}
