/** The recovery proxy accepts encrypted checkpoints, not ordinary command JSON.
 * Keep the ordinary API limit at 1 MiB; the larger transport ceiling only
 * applies to that allowlisted proxy, whose destination still enforces its quota.
 */
export const API_BODY_MAX_BYTES = 1024 * 1024;
export const WATCHTOWER_PROXY_BODY_MAX_BYTES = 8 * 1024 * 1024;

export const withApiBodyLimit = <Server>(
  handle: (request: Request, server: Server) => Response | undefined | Promise<Response | undefined>,
) => async (request: Request, server: Server): Promise<Response | undefined> =>
  await enforceApiBodyLimit(request) ?? await handle(request, server);

export async function enforceApiBodyLimit(request: Request): Promise<Response | null> {
  if (!request.body) return null;
  const limit = new URL(request.url).pathname === '/api/watchtower-proxy'
    ? WATCHTOWER_PROXY_BODY_MAX_BYTES : API_BODY_MAX_BYTES;
  const tooLarge = (bytes: number) => Response.json({
    error: 'API_BODY_TOO_LARGE', bytes, maxBytes: limit,
  }, { status: 413 });
  const declared = Number(request.headers.get('content-length'));
  if (Number.isSafeInteger(declared) && declared > limit) return tooLarge(declared);
  // Retain the original Request identity: server.requestIP(request) is used by
  // operator authorization. Reconstructing it could lose the authenticated peer.
  const body = request.clone().body;
  if (!body) throw new Error('API_BODY_CLONE_MISSING');
  const reader = body.getReader();
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return null;
    size += value.byteLength;
    if (size > limit) {
      // A tee's cancellation waits for its other branch. Do not await it while
      // the untouched original request is deliberately not being dispatched.
      void reader.cancel().catch(error => console.error('API_BODY_CANCEL_FAILED', error));
      return tooLarge(size);
    }
  }
}
