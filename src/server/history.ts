import { EnvSnapshot } from '../types';

// === TIME MACHINE API ===
export const getHistory = (env: { history?: EnvSnapshot[] }) => env.history || [];

export const getSnapshot = (env: { history?: EnvSnapshot[] }, index: number) => {
  const history = env.history || [];
  return index >= 0 && index < history.length ? history[index] : null;
};

export const getCurrentHistoryIndex = (env: { history?: EnvSnapshot[] }) => (env.history || []).length - 1;
