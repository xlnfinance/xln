import { useEffect } from 'react';

import { useExternalStore } from '../../../../../packages/react-adapters/use-external-store';
import { buildXlnInvoiceUri } from '$lib/utils/xlnInvoice';
import {
  walletAccountExternalStore,
  walletAccountStoreController,
} from '../accounts/wallet-account-store';

const ENTITY_ID = /^0x[0-9a-f]{64}$/;

export const WalletAddressDetail = ({ entityId: rawEntityId }: Readonly<{ entityId: string }>) => {
  const entityId = String(rawEntityId || '').trim().toLowerCase();
  const valid = ENTITY_ID.test(entityId);
  const state = useExternalStore(walletAccountExternalStore);
  useEffect(() => {
    if (valid) void walletAccountStoreController.selectEntity(entityId);
    return () => { void walletAccountStoreController.showActiveEntity(); };
  }, [entityId, valid]);
  if (!valid) return <main className="wallet-route-page"><a href="/address">← Address book</a><p className="wallet-eyebrow">invalid deep link</p><h1>Entity ID is malformed</h1><p className="wallet-inline-error" role="alert">Expected a 32-byte 0x-prefixed entity identifier.</p></main>;
  const directory = state.directory.find(candidate => candidate.entityId === entityId) ?? null;
  const projected = state.entity?.entityId === entityId ? state.entity : null;
  if (state.loading && !directory && !projected) return <main className="wallet-route-page"><p>Loading entity projection…</p></main>;
  if (!directory && !projected) return <main className="wallet-route-page"><a href="/address">← Address book</a><p className="wallet-eyebrow">unavailable entity</p><h1>Entity not found</h1><code>{entityId}</code>{state.error && <p className="wallet-inline-error" role="alert">{state.error}</p>}</main>;
  const invoice = buildXlnInvoiceUri({ targetEntityId: entityId });
  return (
    <main className="wallet-route-page" data-testid="wallet-address-detail">
      <header className="wallet-route-header"><div><a href="/address">← Address book</a><p className="wallet-eyebrow">{directory?.isHub ? 'routing hub' : 'entity profile'}</p><h1>{directory?.label ?? projected?.label ?? 'Entity'}</h1><code>{entityId}</code></div><a className="wallet-route-action" href={`/app#pay/${encodeURIComponent(invoice)}`}>Pay this entity</a></header>
      <section className="wallet-address-facts"><div><span>Runtime</span><strong>{directory?.runtimeId || 'active runtime'}</strong></div><div><span>Jurisdiction</span><strong>{directory?.jurisdiction ?? 'unavailable'}</strong></div><div><span>Observed height</span><strong>{projected?.height ?? directory?.height ?? 0}</strong></div><div><span>Accounts</span><strong>{projected?.accounts.length ?? 'not locally owned'}</strong></div></section>
      {projected && <section className="wallet-public-balances"><h2>Local committed projection</h2>{projected.reserves.map(reserve => <article key={reserve.tokenId}><span>{reserve.symbol}</span><strong>{reserve.formatted}</strong><small>{reserve.raw} raw</small></article>)}</section>}
      {state.error && <p className="wallet-inline-error" role="alert">Projection detail unavailable: {state.error}</p>}
    </main>
  );
};
