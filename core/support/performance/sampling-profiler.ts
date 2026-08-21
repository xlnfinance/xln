/**
 * Runtime sampling profiler, off unless explicitly enabled.
 *
 * Engine flags such as `--cpu-prof` only write on a clean exit, so a runtime
 * stopped by a supervisor signal produces nothing. This owns start and dump
 * explicitly: the profile survives whatever ends the process, and a live
 * runtime can be sampled on SIGUSR2 without a restart.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nodeProcess } from '../process/runtime-process';
import { createStructuredLogger } from '../logger';

const profilerLog = createStructuredLogger('runtime.profiler');

type SamplingProfilerModule = {
  startSamplingProfiler: (path?: string) => void;
  samplingProfilerStackTraces: () => unknown;
};

const isSamplingProfilerModule = (value: unknown): value is SamplingProfilerModule =>
  typeof value === 'object'
  && value !== null
  && typeof Reflect.get(value, 'startSamplingProfiler') === 'function'
  && typeof Reflect.get(value, 'samplingProfilerStackTraces') === 'function';

let dumpSamplingProfile: ((reason: string) => void) | null = null;

const resolveDumpDirectory = (): string =>
  String(nodeProcess?.env?.['XLN_RUNTIME_SAMPLING_PROFILE_DIR'] || '').trim() || '/tmp/xln-sampling-profile';

/**
 * @returns true when sampling started, false when the flag is off or the
 * engine has no sampling profiler.
 */
export const startRuntimeSamplingProfiler = async (label: string): Promise<boolean> => {
  if (nodeProcess?.env?.['XLN_RUNTIME_SAMPLING_PROFILE'] !== '1') return false;
  if (dumpSamplingProfile) return true;
  let jsc: SamplingProfilerModule;
  try {
    const candidate: unknown = await import('bun:jsc');
    if (!isSamplingProfilerModule(candidate)) {
      throw new Error('SAMPLING_PROFILER_API_MISSING');
    }
    jsc = candidate;
  } catch (error) {
    profilerLog.warn('sampling.unavailable', {
      label,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  const directory = resolveDumpDirectory();
  mkdirSync(directory, { recursive: true });
  jsc.startSamplingProfiler();
  let dumps = 0;
  dumpSamplingProfile = (reason: string): void => {
    dumps += 1;
    const path = join(directory, `${label}-${dumps}.samples.json`);
    try {
      // Stack traces accumulate for the process lifetime, so every dump is a
      // superset of the previous one. Keep each dump rather than overwriting:
      // a later crash must not erase an earlier successful sample.
      writeFileSync(path, JSON.stringify(jsc.samplingProfilerStackTraces()));
      profilerLog.info('sampling.dumped', { label, reason, path });
    } catch (error) {
      profilerLog.warn('sampling.dump_failed', {
        label,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  nodeProcess?.on?.('SIGUSR2', () => dumpSamplingProfile?.('sigusr2'));
  profilerLog.info('sampling.started', { label, directory });
  return true;
};

export const dumpRuntimeSamplingProfile = (reason: string): void => {
  dumpSamplingProfile?.(reason);
};
