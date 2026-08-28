import type {
  WalletDebtGroup,
  WalletDispute,
  WalletFinancialHealthProjection,
  WalletHistoryEvent,
} from './wallet-financial-health-model';

const shortId = (value: string): string =>
  value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;

const sectionHeading = (number: string, title: string, detail: string, id: string) => (
  <div className="wallet-health-section-heading">
    <div><p>{number}</p><h2 id={id}>{title}</h2></div>
    <span>{detail}</span>
  </div>
);

function DebtGroup({ group }: Readonly<{ group: WalletDebtGroup }>) {
  return (
    <article className="wallet-health-debt-group">
      <header>
        <div>
          <span className={`wallet-health-direction is-${group.direction}`}>
            {group.direction === 'out' ? 'You owe' : 'Owed to you'}
          </span>
          <h3>{group.symbol}</h3>
        </div>
        <div><small>Outstanding</small><strong>{group.outstandingLabel}</strong></div>
      </header>
      <div className="wallet-health-debt-table" role="table" aria-label={`${group.symbol} open debts`}>
        <div className="wallet-health-debt-row is-heading" role="row">
          <span role="columnheader">Counterparty</span>
          <span role="columnheader">Remaining</span>
          <span role="columnheader">Original</span>
          <span role="columnheader">Paid</span>
          <span role="columnheader">Block</span>
        </div>
        {group.entries.map((entry) => (
          <div className="wallet-health-debt-row" role="row" key={entry.debtId}>
            <span role="cell"><strong>{entry.counterpartyLabel}</strong><code title={entry.counterpartyId}>{shortId(entry.counterpartyId)}</code></span>
            <span role="cell">{entry.remainingLabel}</span>
            <span role="cell">{entry.originalLabel}</span>
            <span role="cell">{entry.paidLabel}</span>
            <span role="cell">#{entry.lastUpdatedBlock}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

export function WalletDebtSection({ groups }: Readonly<{ groups: readonly WalletDebtGroup[] }>) {
  return (
    <section className="wallet-health-section" aria-labelledby="wallet-debt-title">
      {sectionHeading('01', 'Open debt', 'Canonical J-event ledger · bounded read', 'wallet-debt-title')}
      {groups.length === 0
        ? <p className="wallet-health-empty">No open debt entries for this Entity.</p>
        : <div className="wallet-health-debt-list">{groups.map((group) => <DebtGroup group={group} key={group.key} />)}</div>}
      <p className="wallet-health-note">The remote projection exposes up to 20 open entries per token direction. Terminal debt events remain in committed history.</p>
    </section>
  );
}

const solvencyStatusLabel = (status: WalletFinancialHealthProjection['solvencyStatus']): string =>
  status === 'unchecked' ? 'On-chain total not supplied' : status === 'balanced' ? 'Conservation balanced' : 'Conservation mismatch';

export function WalletSolvencySection({ projection }: Readonly<{ projection: WalletFinancialHealthProjection }>) {
  return (
    <section className="wallet-health-section" aria-labelledby="wallet-solvency-title">
      {sectionHeading('02', 'Runtime solvency', `${projection.solvencyEntityCount} Entities · ${projection.solvencyAccountViews} Account views`, 'wallet-solvency-title')}
      <div className={`wallet-health-solvency-status is-${projection.solvencyStatus}`} role={projection.solvencyStatus === 'mismatch' ? 'alert' : 'status'}>
        <span aria-hidden="true" />
        <div><strong>{solvencyStatusLabel(projection.solvencyStatus)}</strong><small>Runtime-wide reserves + confirmed collateral at height {projection.height}</small></div>
      </div>
      {projection.solvencyAssets.length === 0 ? (
        <p className="wallet-health-empty">No committed assets are present in this Runtime.</p>
      ) : (
        <div className="wallet-health-solvency-grid">
          {projection.solvencyAssets.map((asset) => (
            <article key={asset.key}>
              <header><div><strong>{asset.symbol}</strong><small>{asset.stackLabel}</small></div><span className={`is-${asset.status}`}>{asset.status}</span></header>
              <dl>
                <div><dt>Reserves</dt><dd>{asset.reservesLabel}</dd></div>
                <div><dt>Confirmed collateral</dt><dd>{asset.collateralLabel}</dd></div>
                <div><dt>Internal value</dt><dd>{asset.internalValueLabel}</dd></div>
                <div><dt>Depository total</dt><dd>{asset.expectedValueLabel}</dd></div>
                <div><dt>Difference</dt><dd>{asset.deltaLabel}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

const proofLabel = (status: WalletDispute['proofStatus']): string =>
  status === 'both-hankos'
    ? 'Local + peer Hankos present'
    : status === 'local-hanko'
      ? 'Local Hanko present'
      : 'No compact Hanko evidence';

export function WalletDisputesSection({
  busy,
  projection,
  selectPage,
}: Readonly<{
  projection: WalletFinancialHealthProjection;
  busy: boolean;
  selectPage: (page: number) => void;
}>) {
  return (
    <section className="wallet-health-section" aria-labelledby="wallet-disputes-title">
      {sectionHeading('03', 'Dispute lifecycle', `${projection.accountsTotal} Accounts · page ${projection.accountsPage + 1}`, 'wallet-disputes-title')}
      {projection.disputes.length === 0 ? <p className="wallet-health-empty">No preparing or disputed Accounts on this page.</p> : (
        <div className="wallet-health-disputes">
          {projection.disputes.map((dispute) => (
            <article key={dispute.counterpartyId}>
              <header><div><strong>{dispute.counterpartyLabel}</strong><code title={dispute.counterpartyId}>{shortId(dispute.counterpartyId)}</code></div><span className={`is-${dispute.phase}`}>{dispute.phase}</span></header>
              <dl>
                <div><dt>Account height</dt><dd>{dispute.accountHeight}</dd></div>
                <div><dt>Committed frame</dt><dd>{dispute.frameHeight}</dd></div>
                <div><dt>Response windows</dt><dd>{dispute.responseWindowLabel}</dd></div>
                <div><dt>Proof state</dt><dd>{proofLabel(dispute.proofStatus)}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      )}
      {projection.accountsPageCount > 1 ? (
        <nav className="wallet-health-pagination" aria-label="Dispute Account pages">
          <button disabled={busy || projection.accountsPage === 0} onClick={() => selectPage(projection.accountsPage - 1)} type="button">Previous Accounts</button>
          <span>{projection.accountsPage + 1} / {projection.accountsPageCount}</span>
          <button disabled={busy || projection.accountsPage + 1 >= projection.accountsPageCount} onClick={() => selectPage(projection.accountsPage + 1)} type="button">Next Accounts</button>
        </nav>
      ) : null}
    </section>
  );
}

const formatTimestamp = (timestamp: number): string => timestamp === 0 ? 'No timestamp' : new Intl.DateTimeFormat('en-US', {
  month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
}).format(new Date(timestamp));

function HistoryEvent({ event }: Readonly<{ event: WalletHistoryEvent }>) {
  return (
    <article className={`wallet-health-event is-${event.kind} is-${event.direction}`}>
      <div className="wallet-health-event-marker" aria-hidden="true" />
      <div className="wallet-health-event-copy">
        <header><strong>{event.title}</strong><span>{event.status}</span></header>
        <p>{event.subtitle}</p>
        <footer>
          <span>{formatTimestamp(event.timestamp)}</span><span>h{event.height}</span><span>{event.kind}</span><span>{event.type}</span>
          {event.amountLabel ? <strong>{event.amountLabel}</strong> : null}
        </footer>
      </div>
    </article>
  );
}

export function WalletHistorySection({
  busy,
  projection,
  newer,
  older,
}: Readonly<{
  projection: WalletFinancialHealthProjection;
  busy: boolean;
  newer: () => void;
  older: () => void;
}>) {
  return (
    <section className="wallet-health-section" aria-labelledby="wallet-history-title">
      {sectionHeading('04', 'Committed history', `Page ${projection.historyPage + 1} · 25 events max`, 'wallet-history-title')}
      {projection.history.length === 0
        ? <p className="wallet-health-empty">No committed activity on this history page.</p>
        : <div className="wallet-health-history">{projection.history.map((event) => <HistoryEvent event={event} key={event.id} />)}</div>}
      <nav className="wallet-health-pagination" aria-label="Committed history pages">
        <button disabled={busy || projection.historyPage === 0} onClick={newer} type="button">Newer</button>
        <span>Page {projection.historyPage + 1}</span>
        <button disabled={busy || projection.historyNextBeforeHeight === null} onClick={older} type="button">Older</button>
      </nav>
    </section>
  );
}
