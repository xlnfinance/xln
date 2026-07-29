import { isRuntimePerfProfileEnabled, readRuntimePerfSlowMs } from '../../infra/perf-runtime-flags';
import { nodeProcess } from '../../infra/runtime-process';

const ENTITY_FRAME_PROFILE =
  nodeProcess?.env?.['XLN_ENTITY_FRAME_PROFILE'] === '1' ||
  nodeProcess?.env?.['XLN_ENTITY_INPUT_PROFILE'] === '1' ||
  nodeProcess?.env?.['XLN_RUNTIME_PROCESS_PROFILE'] === '1';

const ENTITY_FRAME_SLOW_MS = Math.max(0, Number(nodeProcess?.env?.['XLN_ENTITY_FRAME_SLOW_MS'] || '1000'));

export const entityFrameProfileEnabled = (): boolean =>
  ENTITY_FRAME_PROFILE || isRuntimePerfProfileEnabled('XLN_ENTITY_FRAME_PROFILE', 'XLN_ENTITY_INPUT_PROFILE');

export const entityFrameSlowMs = (): number =>
  readRuntimePerfSlowMs('XLN_ENTITY_FRAME_SLOW_MS', ENTITY_FRAME_SLOW_MS);
