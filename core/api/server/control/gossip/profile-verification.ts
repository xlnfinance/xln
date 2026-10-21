import { parseProfile } from '../../../../entity/profile';
import { verifyProfileSignature } from '../../../../entity/profile/profile-signing';
import { serializeTaggedJson } from '../../../../protocol/serialization';
import { decodeValidatedBinaryPayload } from '../../../../protocol/serialization/binary-codec';
import { LIMITS } from '../../../../config/constants';
import { withRuntimeCommittedRead } from '../../../../runtime/frame/lifecycle/writer-lock';
import type { RuntimeReplica } from '../../../../runtime/types';
import { readCappedControlBytes, requireDaemonControlAuth } from '../auth';

// The canonical codec adds one framing byte; JSON expansion must not shrink profile admission.
export const PROFILE_CONTROL_BODY_MAX_BYTES = LIMITS.MAX_PROFILE_BYTES + 1;

/** Verify against this managed Runtime's certified registry, never the supplied board. */
export const handleGossipProfileVerification = async (
  request: Request,
  env: RuntimeReplica,
  headers: HeadersInit,
): Promise<Response> => {
  const authError = requireDaemonControlAuth(request, env);
  if (authError) return authError;
  const profile = decodeValidatedBinaryPayload(
    await readCappedControlBytes(request, PROFILE_CONTROL_BODY_MAX_BYTES),
    parseProfile,
  );
  const result = await withRuntimeCommittedRead(env, () => verifyProfileSignature(profile, env));
  return new Response(serializeTaggedJson(result), { headers });
};
