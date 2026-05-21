import { ethers } from 'ethers';
import { registerSignerKey } from '../account-crypto';
import { serializeTaggedJson } from '../serialization-utils';
import type { parseTaggedControlBody as parseTaggedControlBodyType } from './auth';

type SignerControlDeps = {
  parseTaggedControlBody: typeof parseTaggedControlBodyType;
};

export const handleSignerRegistration = async (
  req: Request,
  headers: HeadersInit,
  deps: SignerControlDeps,
): Promise<Response> => {
  try {
    const body = await deps.parseTaggedControlBody<{ signerId?: unknown; privateKeyHex?: unknown }>(req);
    const signerId = typeof body?.signerId === 'string' ? body.signerId.trim().toLowerCase() : '';
    const privateKeyHex = typeof body?.privateKeyHex === 'string' ? body.privateKeyHex.trim().toLowerCase() : '';
    if (!ethers.isAddress(signerId)) {
      return new Response(
        serializeTaggedJson({ ok: false, error: 'signerId must be an EOA address' }),
        { status: 400, headers },
      );
    }
    if (!ethers.isHexString(privateKeyHex, 32)) {
      return new Response(
        serializeTaggedJson({ ok: false, error: 'privateKeyHex must be a 32-byte hex string' }),
        { status: 400, headers },
      );
    }
    registerSignerKey(signerId, ethers.getBytes(privateKeyHex));
    return new Response(
      serializeTaggedJson({
        ok: true,
        signerId,
      }),
      { headers },
    );
  } catch (error) {
    return new Response(
      serializeTaggedJson({ ok: false, error: (error as Error).message || 'Failed to register signer' }),
      { status: 500, headers },
    );
  }
};
