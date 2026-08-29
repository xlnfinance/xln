import type { WalletMarketProjection } from './wallet-market-model';
import type { WalletMarketSource } from './wallet-market-source';

const shortCounterparty = (value: string | undefined): string => value
  ? `${value.slice(0, 8)}…${value.slice(-6)}`
  : 'Runtime';

const runtimeTimeLabel = (timestamp: number): string => timestamp < 946_684_800_000
  ? `Runtime t+${timestamp}ms`
  : new Date(timestamp).toLocaleString();

export function WalletMarketActivityView({
  projection,
  source,
}: Readonly<{ projection: WalletMarketProjection; source: WalletMarketSource }>) {
  return (
    <section className="wallet-market-activity" aria-labelledby="wallet-market-activity-title">
      <header>
        <div><p className="wallet-shell-eyebrow">Persisted Runtime history</p><h2 id="wallet-market-activity-title">Activity</h2></div>
        <nav aria-label="Activity kind">
          {(['all', 'offchain', 'onchain'] as const).map((kind) => (
            <button aria-current={projection.activityKind === kind ? 'page' : undefined} className={projection.activityKind === kind ? 'is-current' : ''} key={kind} onClick={() => source.selectActivityKind(kind)} type="button">{kind}</button>
          ))}
        </nav>
      </header>
      {projection.activity.length ? (
        <ol>
          {projection.activity.map((event) => (
            <li key={event.id}>
              <span className={`is-${event.kind}`} aria-hidden="true" />
              <div><strong>{event.title}</strong><p>{event.subtitle}</p><small>{shortCounterparty(event.counterpartyId)} · height {event.height}</small></div>
              <div><b>{event.amountLabel ?? event.status}</b><time>{runtimeTimeLabel(event.timestamp)}</time></div>
            </li>
          ))}
        </ol>
      ) : <p className="wallet-market-empty-line">No {projection.activityKind === 'all' ? '' : `${projection.activityKind} `}activity is persisted on this page.</p>}
      <footer>
        <button disabled={projection.activityPage === 0} onClick={() => source.selectNewerActivity()} type="button">Newer</button>
        <span>Page {projection.activityPage + 1}</span>
        <button disabled={projection.activityNextBeforeHeight === null} onClick={() => source.selectOlderActivity()} type="button">Older</button>
      </footer>
    </section>
  );
}
