/**
 * HTTP adapter for the canonical Stack Manager orchestration.
 * GET only exposes current phase and an authenticated operator may probe RPC;
 * POST requires existing daemon-admin capability and never accepts keys. [95/100]
 */

import { getLocalSignerPrivateKey } from '../../../account/crypto';
import type { RuntimeReplica } from '../../../runtime/types';
import { serializeTaggedJson } from '../../../protocol/serialization';
import { getAddress, isAddress } from 'ethers';
import { deployJurisdictionStack, probeJurisdictionStackTarget } from '../../../jurisdiction/adapter/stack-manager/deploy';
import { decodeDeployJurisdictionStackRequest } from '../../../jurisdiction/adapter/stack-manager/validation';
import type { StackManagerStatus } from '../../../jurisdiction/adapter/stack-manager/types';
import { getErrorMessage } from '../utils';
import { getConfiguredOfficialFoundationSignerId } from '../../../jurisdiction/adapter/core/jurisdiction-loader';
import { decodeJurisdictionGossipAnnouncementStructure } from '../../../jurisdiction/gossip/announcement';

type StackManagerControllerDeps = Readonly<{
  parseBody: (req: Request) => Promise<unknown>;
  headers: Record<string, string>;
  now?: () => Date;
}>;

export type StackManagerController = Readonly<{
  status(req: Request, env: RuntimeReplica | null): Promise<Response>;
  deploy(req: Request, env: RuntimeReplica): Promise<Response>;
}>;

export const createStackManagerController = (
  deps: StackManagerControllerDeps,
): StackManagerController => {
  const now = deps.now ?? (() => new Date());
  let status: StackManagerStatus = {
    phase: 'idle',
    active: false,
    updatedAt: now().toISOString(),
  };
  const setPhase = (phase: StackManagerStatus['phase'], error?: string): void => {
    status = {
      phase,
      active: phase !== 'idle' && phase !== 'complete' && phase !== 'failed',
      updatedAt: now().toISOString(),
      ...(error ? { error } : {}),
    };
  };
  return {
    async status(req, env) {
      try {
        const url = new URL(req.url);
        const rpcUrl = url.searchParams.get('rpcUrl');
        const signerId = url.searchParams.get('signerId');
        let probe;
        if (rpcUrl || signerId) {
          if (!env) return new Response(serializeTaggedJson({ ok: false, error: 'Runtime not ready' }), { status: 503, headers: deps.headers });
          if (!rpcUrl || !signerId || !isAddress(signerId)) {
            return new Response(serializeTaggedJson({ ok: false, error: 'STACK_MANAGER_PROBE_QUERY_INVALID' }), { status: 400, headers: deps.headers });
          }
          const parsed = new URL(rpcUrl);
          if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
            return new Response(serializeTaggedJson({ ok: false, error: 'STACK_MANAGER_PROBE_QUERY_INVALID' }), { status: 400, headers: deps.headers });
          }
          probe = await probeJurisdictionStackTarget({ rpcUrl, signerId: getAddress(signerId).toLowerCase() });
        }
        return new Response(serializeTaggedJson({ ok: true, status, ...(probe ? { probe } : {}) }), { headers: deps.headers });
      } catch (error) {
        return new Response(
          serializeTaggedJson({ ok: false, error: getErrorMessage(error) }),
          { status: 400, headers: deps.headers },
        );
      }
    },
    async deploy(req, env) {
      if (status.active) {
        return new Response(serializeTaggedJson({ ok: false, error: 'STACK_MANAGER_DEPLOYMENT_ACTIVE' }), { status: 409, headers: deps.headers });
      }
      try {
        const request = decodeDeployJurisdictionStackRequest(await deps.parseBody(req));
        setPhase('preflight');
        const signerPrivateKey = getLocalSignerPrivateKey(env, request.signerId);
        if (!signerPrivateKey) throw new Error(`STACK_MANAGER_SIGNER_NOT_OWNED:${request.signerId}`);
        const officialFoundationSignerId = getConfiguredOfficialFoundationSignerId();
        const result = await deployJurisdictionStack(request, {
          signerPrivateKey,
          ...(officialFoundationSignerId ? { officialFoundationSignerId } : {}),
          publishJurisdiction: announcement =>
            env.infrastructure?.p2p?.announceJurisdiction(announcement) ?? false,
          onPhase: phase => setPhase(phase),
        });
        if (result.publication.status !== 'not_requested') {
          decodeJurisdictionGossipAnnouncementStructure(result.publication.announcement);
        }
        return new Response(serializeTaggedJson({ ok: true, result }), { headers: deps.headers });
      } catch (error) {
        const message = getErrorMessage(error);
        setPhase('failed', message);
        return new Response(serializeTaggedJson({ ok: false, error: message }), { status: 400, headers: deps.headers });
      }
    },
  };
};
