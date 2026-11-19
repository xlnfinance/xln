#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { safeStringify } from '../../../../core/protocol/serialization';
import { effectiveRebalanceTerms } from '../../../../core/account/config/term-notice';
import { isLeftEntity } from '../../../../core/account/utils';
import { prepareIdentities } from '../identities';
import { inspectHub, inspectBilateral, inspectMakerDepth } from './observations';

const directory = resolve('.logs/ts-usdc-cross-j-poc/public');
const identities = prepareIdentities(directory);
const { bootUser, openPocAccount, userReplica, closeUser } = await import('../../../../core/scenarios/usdc-poc/user');
const runtime = await import('../../../../core/runtime');
const user = await bootUser('http://localhost:8080', join(directory, 'user'));
const sourceHub = identities.find(value => value.role === 'hub')?.chains.find(value => value.chainId === 11155111);
if (!sourceHub) throw new Error('USDC_PREFLIGHT_SOURCE_HUB_MISSING');
const inspector = await inspectHub(directory, sourceHub.signerId);
try {
  const accounts = [];
  for (const jurisdiction of user.jurisdictions) {
    const own = user.identities.find(value => value.chainId === jurisdiction.chainId);
    const hub = identities
      .find(value => value.role === 'hub')
      ?.chains.find(value => value.chainId === jurisdiction.chainId);
    if (!own || !hub) throw new Error('USDC_PREFLIGHT_TRANSPORT_IDENTITY_MISSING');
    const participant = { ...user, ...own, jurisdiction };
    await openPocAccount(participant, 'http://localhost:8080', hub.entityId);
    const account = userReplica(participant).state.accounts.get(hub.entityId);
    if (!account?.currentFrame) throw new Error('USDC_PREFLIGHT_SIGNED_ACCOUNT_MISSING');
    const snapshot =
      account.state.rebalanceFeePolicies?.get(1)?.[isLeftEntity(own.entityId, hub.entityId) ? 'right' : 'left'];
    if (!snapshot || !account.currentDisputeProofHanko) throw new Error('USDC_PREFLIGHT_SIGNED_TARIFF_MISSING');
    const profile = user.env.gossip.getProfile(hub.entityId);
    if (!profile) throw new Error('USDC_PREFLIGHT_VERIFIED_PROFILE_MISSING');
    accounts.push({
      chainId: jurisdiction.chainId,
      user: own,
      hub,
      profile,
      bilateral: await inspectBilateral(inspector, participant, hub.entityId),
      height: account.currentHeight,
      frame: account.currentFrame,
      proofHanko: account.currentDisputeProofHanko,
      proofBodyHash: account.currentDisputeProofBodyHash,
      tariff: { snapshot, effective: effectiveRebalanceTerms(snapshot, account.currentFrame.timestamp) },
      grantedUserCredit: '0',
      financialFundingPerformed: false,
    });
  }
  writeFileSync(
    join(directory, 'transport.json'),
    safeStringify(
      {
        status: 'authenticated',
        runtimeId: user.env.runtimeId,
        height: user.env.state.height,
        relayConnected: runtime.getP2P(user.env)?.isConnected() === true,
        accounts,
        makerRoutes: await inspectMakerDepth(inspector, sourceHub.entityId),
        publicFinancialBroadcasts: 0,
      },
      2,
    ),
    { mode: 0o600 },
  );
} finally {
  inspector.disconnect();
  await closeUser(user);
}
