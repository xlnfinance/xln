import { ethers } from 'ethers';
import { registerSignerKey } from '../../../account/crypto';
import {
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../protocol/boundary/boundary-primitives';
import { serializeTaggedJson } from '../../../protocol/serialization';
import { getControlBodyErrorStatus } from './auth';
import type { parseTaggedControlBody } from './auth';
import type { RuntimeReplica } from '../../../runtime/types';

type SignerControlDeps = {
  parseTaggedControlBody: typeof parseTaggedControlBody;
  env: RuntimeReplica;
};

export const decodeSignerRegistration = (
  value: unknown,
): { signerId: string; privateKeyHex: string } => {
  const body = requireBoundaryRecord(value, 'SIGNER_REGISTRATION_BODY_INVALID');
  requireExactBoundaryKeys(
    body,
    ['signerId', 'privateKeyHex'],
    [],
    'SIGNER_REGISTRATION_FIELDS_INVALID',
  );
  if (typeof body['signerId'] !== 'string') {
    throw new Error('SIGNER_REGISTRATION_SIGNER_ID_INVALID');
  }
  if (typeof body['privateKeyHex'] !== 'string') {
    throw new Error('SIGNER_REGISTRATION_PRIVATE_KEY_INVALID');
  }
  return {
    signerId: body['signerId'].trim().toLowerCase(),
    privateKeyHex: body['privateKeyHex'].trim().toLowerCase(),
  };
};

export const handleSignerRegistration = async (
  req: Request,
  headers: HeadersInit,
  deps: SignerControlDeps,
): Promise<Response> => {
  let registration: ReturnType<typeof decodeSignerRegistration>;
  try {
    registration = decodeSignerRegistration(
      await deps.parseTaggedControlBody(req),
    );
  } catch (error) {
    return new Response(
      serializeTaggedJson({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      { status: getControlBodyErrorStatus(error, 400), headers },
    );
  }
  const { signerId, privateKeyHex } = registration;
  try {
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
    registerSignerKey(deps.env, signerId, ethers.getBytes(privateKeyHex));
    return new Response(
      serializeTaggedJson({
        ok: true,
        signerId,
      }),
      { headers },
    );
  } catch (error) {
    return new Response(
      serializeTaggedJson({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to register signer',
      }),
      { status: getControlBodyErrorStatus(error, 500), headers },
    );
  }
};
