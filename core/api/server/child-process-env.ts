export const sanitizeChildProcessEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const next: NodeJS.ProcessEnv = { ...env };
  delete next['NO_COLOR'];
  return next;
};
