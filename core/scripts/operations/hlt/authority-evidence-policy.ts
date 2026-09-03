/** Authority recording measures semantic parity, so transport availability is
 * production direct→relay routing rather than the TPS-only direct isolation. */
export const hltAuthorityEvidenceRecording = (env: NodeJS.ProcessEnv): boolean => {
  const value = String(env['XLN_HLT_AUTHORITY_EVIDENCE'] ?? '').trim();
  if (!value) return false;
  if (value !== '1') throw new Error(`HLT_AUTHORITY_EVIDENCE_FLAG_INVALID:${value}`);
  return true;
};

/** Owner-approved real-frame tail after the explicit parity base checkpoint. */
export const HLT_AUTHORITY_MIN_RUNTIME_FRAMES = 110;

/** Authority users keep the production relay session alive. Ordinary TPS HLT
 * deliberately measures the direct path only and therefore owns no relay. */
export const hltAuthorityEvidenceRelayUrls = (env: NodeJS.ProcessEnv): readonly string[] => {
  if (!hltAuthorityEvidenceRecording(env)) return [];
  const portBase = Number(env['XLN_PORT_BASE']);
  if (!Number.isSafeInteger(portBase) || portBase < 1 || portBase + 4 > 65_535) {
    throw new Error(`HLT_AUTHORITY_EVIDENCE_PORT_BASE_INVALID:${String(env['XLN_PORT_BASE'] ?? '')}`);
  }
  return [`ws://127.0.0.1:${String(portBase + 4)}/relay`];
};
