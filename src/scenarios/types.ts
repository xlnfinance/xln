/**
 * XLN Scenario Type Definitions
 *
 * Type-safe representation of economic scenarios that unfold over time.
 */

/**
 * View state for cinematic camera control
 */
export interface ViewState {
  camera?: 'orbital' | 'overview' | 'follow' | 'free';
  zoom?: number;
  focus?: string; // Entity ID to center on
  panel?: 'accounts' | 'transactions' | 'consensus' | 'network';
  speed?: number; // Playback speed multiplier
  position?: { x: number; y: number; z: number }; // Camera position
  rotation?: { x: number; y: number; z: number }; // Camera rotation
}

/**
 * Action parameter - can be positional or named
 */
export type ActionParam = string | number | bigint | ViewState | { [key: string]: string | number | bigint };

/**
 * Single action to execute at a timestamp
 */
export interface ScenarioAction {
  type: string; // e.g., 'openAccount', 'deposit', 'withdraw'
  entityId?: string; // Subject entity (if applicable)
  params: ActionParam[]; // Positional and named parameters
  sourceLineNumber?: number; // For error reporting
}

/**
 * Event at a specific timestamp
 */
export interface ScenarioEvent {
  timestamp: number; // Seconds (can be decimal)
  title?: string; // Optional human-readable title
  description?: string; // Optional multiline description
  actions: ScenarioAction[];
  viewState?: ViewState; // Optional camera/UI state
}

/**
 * Repeating block of actions
 */
export interface RepeatBlock {
  interval: number; // Seconds between repetitions
  actions: ScenarioAction[];
  startTimestamp: number; // When this repeat block was defined
  sourceLineNumber?: number;
}

/**
 * Complete scenario definition
 */
export interface Scenario {
  seed: string; // Determinism seed (empty string if not specified)
  events: ScenarioEvent[]; // Timeline of events
  repeatBlocks: RepeatBlock[]; // Continuous repeating actions
  includes: string[]; // Paths to included scenarios (for tracking)
  metadata?: {
    title?: string;
    description?: string;
    author?: string;
    version?: string;
    tags?: string[];
  };
}

/**
 * Parser context for tracking state during parsing
 */
export interface ParserContext {
  currentTimestamp: number;
  currentTitle?: string;
  currentDescription: string[];
  currentActions: ScenarioAction[];
  currentViewState?: ViewState;
  lineNumber: number;
  inRepeatBlock: boolean;
  repeatBlockActions: ScenarioAction[];
  repeatInterval?: number;
  repeatStartTimestamp?: number;
}

/**
 * Parsed scenario ready for execution
 */
export interface ParsedScenario {
  scenario: Scenario;
  errors: ScenarioError[];
  warnings: ScenarioWarning[];
}

/**
 * Error during scenario parsing or execution
 */
export interface ScenarioError {
  lineNumber?: number;
  message: string;
  context?: string; // Surrounding text for debugging
}

/**
 * Warning during scenario parsing
 */
export interface ScenarioWarning {
  lineNumber?: number;
  message: string;
  suggestion?: string;
}

/**
 * Execution context for running scenarios
 */
export interface ScenarioExecutionContext {
  scenario: Scenario;
  currentFrameIndex: number;
  totalFrames: number;
  elapsedTime: number; // Seconds
  entityMapping: Map<string, string>; // scenario ID -> actual entity address
  viewStateHistory: Map<number, ViewState>; // frame index -> view state
}

/**
 * Result of scenario execution
 */
export interface ScenarioExecutionResult {
  success: boolean;
  framesGenerated: number;
  finalTimestamp: number;
  errors: ScenarioError[];
  context: ScenarioExecutionContext;
}

/**
 * URL parameters for scenario sharing
 */
export interface ScenarioURLParams {
  scenario?: string; // Base64-encoded scenario text
  shorthand?: string; // Short lookup key (e.g., 'diamonddybvig')
  loop?: string; // Format: "start:end" in seconds
  speed?: number;
  autoplay?: boolean;
  edit?: boolean;
}

/**
 * Range expansion helper
 */
export interface Range {
  start: number;
  end: number;
}

/**
 * Helper to parse range syntax (e.g., "3..5")
 */
export function parseRange(input: string): Range | null {
  const match = input.match(/^(\d+)\.\.(\d+)$/);
  if (!match || !match[1] || !match[2]) return null;

  const start = parseInt(match[1], 10);
  const end = parseInt(match[2], 10);

  if (start > end) {
    return null; // Invalid range
  }

  return { start, end };
}

/**
 * Helper to expand range to array of numbers
 */
export function expandRange(range: Range): number[] {
  const result: number[] = [];
  for (let i = range.start; i <= range.end; i++) {
    result.push(i);
  }
  return result;
}

/**
 * Helper to parse key=value parameters
 */
export function parseNamedParam(input: string): { key: string; value: string } | null {
  const match = input.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=(.+)$/);
  if (!match || !match[1] || !match[2]) return null;
  return { key: match[1], value: match[2] };
}

/**
 * Helper to convert named params to object
 */
export function namedParamsToObject(params: ActionParam[]): Record<string, string | number | bigint> {
  const result: Record<string, string | number | bigint> = {};

  for (const param of params) {
    if (typeof param === 'object' && !('start' in param)) {
      Object.assign(result, param);
    }
  }

  return result;
}

/**
 * Helper to get positional params only
 */
export function getPositionalParams(params: ActionParam[]): (string | number | bigint)[] {
  return params.filter(p => typeof p !== 'object' || ('start' in p)) as (string | number | bigint)[];
}
