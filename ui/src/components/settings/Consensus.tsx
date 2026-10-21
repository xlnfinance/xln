import { useEffect, useState, type ReactNode } from 'react';
import {
  buildEntityConsensusSettingsView,
  type EntityConsensusSettingsView,
} from '@xln/frontend/lib/components/Entity/workspace/entity-consensus-settings';
import { withRuntimeCommittedRead } from '@xln/core/runtime/frame/lifecycle/writer-lock';
import { getAdapter, getEmbeddedEnv } from '../../runtime/adapter';
import { useApp } from '../../runtime/store';
import { useWallet } from '../../runtime/views';
import './consensus.css';

const short = (value: string | null) => (value ? `${value.slice(0, 12)}…${value.slice(-6)}` : '—');
const time = (value: number | null) => (value !== null && value > 0 ? new Date(value).toISOString() : '—');
const entityHeight = (value: number | null) => (value === null ? '—' : `E${value}`);

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Consensus() {
  const activeEntityId = useApp(s => s.activeEntityId);
  const vaultId = useApp(s => s.activeVaultId);
  const height = useApp(s => s.height);
  const status = useApp(s => s.adapterStatus);
  const tokens = useApp(s => s.tokenCatalog);
  const wallet = useWallet(activeEntityId);
  const [revision, setRevision] = useState(0);
  useEffect(() => getAdapter()?.onChange(() => setRevision(value => value + 1)), [status, activeEntityId, vaultId]);
  const owner = `${vaultId}:${wallet.entityId}:${wallet.signerId}`;
  const [snapshot, setSnapshot] = useState<
    | { owner: string; kind: 'ready'; view: EntityConsensusSettingsView }
    | { owner: string; kind: 'unavailable' }
    | { owner: string; kind: 'error'; message: string }
    | null
  >(null);
  useEffect(() => {
    const env = getEmbeddedEnv();
    if (!env || !wallet.entityId || !wallet.signerId) {
      setSnapshot({ owner, kind: 'unavailable' });
      return;
    }
    let cancelled = false;
    // Read the exact signer under the Runtime lease; never render an in-flight H+1.
    void withRuntimeCommittedRead(env, () => {
      if (cancelled) return null;
      const replica = env.state.eReplicas.get(`${wallet.entityId}:${wallet.signerId}`);
      return replica
        ? buildEntityConsensusSettingsView(replica, env.state.height, true, {
            resolveTokenMetadata: tokenId => tokens.find(token => token.tokenId === tokenId) ?? null,
          })
        : null;
    }).then(
      view => {
        if (!cancelled) setSnapshot(view ? { owner, kind: 'ready', view } : { owner, kind: 'unavailable' });
      },
      error => {
        if (!cancelled)
          setSnapshot({ owner, kind: 'error', message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [owner, wallet.entityId, wallet.signerId, height, status, tokens, revision]);

  if (!snapshot || snapshot.owner !== owner) return <p className="muted">Reading committed consensus state…</p>;
  if (snapshot.kind === 'error') return <p role="alert">Consensus inspection failed: {snapshot.message}</p>;
  if (snapshot.kind === 'unavailable')
    return <p className="muted">Detailed consensus inspection needs the selected signer’s local runtime.</p>;
  const view = snapshot.view;
  return (
    <section className="consensus-settings" data-testid="settings-consensus-panel" aria-label="Consensus">
      <div className="consensus-summary">
        <article>
          <span>Runtime height</span>
          <strong>R{view.runtimeHeight}</strong>
        </article>
        <article>
          <span>Entity height</span>
          <strong>E{view.entityHeight}</strong>
          <small>{time(view.entityTimestamp)}</small>
        </article>
        <article>
          <span>J finalized / scanned</span>
          <strong>
            J{view.lastFinalizedJHeight} / {view.scannedJHeight === null ? 'Unavailable' : `J${view.scannedJHeight}`}
          </strong>
        </article>
        <article>
          <span>Account machines</span>
          <strong>{view.accounts.length}</strong>
          <small>{view.accounts.filter(account => account.pendingHeight !== null).length} pending</small>
        </article>
      </div>
      <div className="consensus-columns">
        <section className="consensus-card">
          <h3>Board</h3>
          <dl>
            <Fact label="Mode">{view.boardMode}</Fact>
            <Fact label="Threshold">
              {view.threshold.toString()} / {view.totalShares.toString()}
            </Fact>
            <Fact label="Leader view">{view.leaderView}</Fact>
            <Fact label="Changed at">E{view.leaderChangedAtHeight}</Fact>
          </dl>
          <div data-testid="settings-consensus-board" className="consensus-rows">
            {view.board.map(member => (
              <div className="consensus-row" key={member.signerId}>
                <code title={member.signerId}>{short(member.signerId)}</code>
                <span>{member.shares.toString()} shares</span>
                {member.isLeader && <b>leader</b>}
                {member.isLocalSigner && <b>this signer</b>}
              </div>
            ))}
          </div>
        </section>
        <section className="consensus-card">
          <h3>Frame progress</h3>
          <dl>
            <Fact label="Parent hash">
              <code title={view.entityFrameHash}>{short(view.entityFrameHash)}</code>
            </Fact>
            <Fact label="J history root">
              <code title={view.jHistoryRoot}>{short(view.jHistoryRoot)}</code>
            </Fact>
            <Fact label="Proposed">{entityHeight(view.pendingFrameHeight)}</Fact>
            <Fact label="Locked">{entityHeight(view.lockedFrameHeight)}</Fact>
            <Fact label="Proposal hash">
              <code title={view.pendingFrameHash ?? ''}>{short(view.pendingFrameHash)}</code>
            </Fact>
            <Fact label="Locked hash">
              <code title={view.lockedFrameHash ?? ''}>{short(view.lockedFrameHash)}</code>
            </Fact>
            <Fact label="Last progress">{time(view.lastConsensusProgressAt)}</Fact>
            <Fact label="J prefix certificate">{view.jPrefixCertified ? 'present' : 'none'}</Fact>
          </dl>
        </section>
      </div>
      <section className="consensus-card">
        <h3>Accounts</h3>
        <div className="consensus-table">
          <table data-testid="settings-consensus-accounts">
            <thead>
              <tr>
                <th>Counterparty</th>
                <th>Account height</th>
                <th>Timestamp</th>
                <th>State hash</th>
                <th>Pending</th>
              </tr>
            </thead>
            <tbody>
              {view.accounts.length ? (
                view.accounts.map(account => (
                  <tr key={account.counterpartyId}>
                    <td>
                      <code title={account.counterpartyId}>{short(account.counterpartyId)}</code>
                    </td>
                    <td>A{account.currentHeight}</td>
                    <td>{time(account.currentTimestamp)}</td>
                    <td>
                      <code title={account.currentHash}>{short(account.currentHash)}</code>
                    </td>
                    <td>
                      {account.pendingHeight === null
                        ? '—'
                        : `A${account.pendingHeight} · ${short(account.pendingHash)}`}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5}>No accounts.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <div className="consensus-columns">
        <section className="consensus-card">
          <h3>Governance</h3>
          <div data-testid="settings-consensus-proposals" className="consensus-rows">
            {view.proposals.length ? (
              view.proposals.map(proposal => (
                <div className="consensus-proposal" key={proposal.id}>
                  <strong>{proposal.actionType} · pending</strong>
                  <code title={proposal.id}>{short(proposal.id)}</code>
                  <small>
                    {proposal.yesShares.toString()} yes · {proposal.noShares.toString()} no ·{' '}
                    {proposal.abstainShares.toString()} abstain · threshold {view.threshold.toString()}
                  </small>
                  {proposal.payments.map((payment, index) => (
                    <section
                      key={index}
                      className="consensus-payment"
                      data-testid="settings-consensus-payment"
                      aria-label="Collective HTLC payment approval"
                    >
                      <strong>HTLC payment approval · {payment.deliveryMode}</strong>
                      <dl>
                        <Fact label="Final recipient">
                          <code>{payment.recipientEntityId}</code>
                        </Fact>
                        <Fact label="Asset">
                          {payment.tokenName ?? payment.tokenSymbol ?? 'Unknown'} · #{payment.tokenId}
                        </Fact>
                        <Fact label="Recipient amount">{payment.recipientAmount.toString()}</Fact>
                        <Fact label="Maximum sender debit">{payment.maxSenderDebit.toString()}</Fact>
                        <Fact label="Maximum fee">{payment.maxFee.toString()}</Fact>
                        <Fact label="Hashlock">
                          <code>{payment.hashlock ?? 'Pending proposer derivation'}</code>
                        </Fact>
                      </dl>
                    </section>
                  ))}
                </div>
              ))
            ) : (
              <p>No proposals.</p>
            )}
          </div>
        </section>
        <section className="consensus-card">
          <h3>Certificates</h3>
          <dl>
            <Fact label="Leader votes">{view.leaderVoteCount}</Fact>
            <Fact label="Leader certificate">{view.leaderCertificateVoteCount} votes</Fact>
            <Fact label="Certified suffix">{view.certifiedLineageLength} frames</Fact>
            <Fact label="Hanko witnesses">{view.hankoWitnessCount}</Fact>
            <Fact label="Anchor">{entityHeight(view.certifiedAnchorHeight)}</Fact>
            <Fact label="Anchor hash">
              <code title={view.certifiedAnchorHash ?? ''}>{short(view.certifiedAnchorHash)}</code>
            </Fact>
          </dl>
        </section>
      </div>
      <section className="consensus-card">
        <h3>Scheduled hooks</h3>
        <div data-testid="settings-consensus-hooks" className="consensus-rows">
          {view.hooks.length ? (
            view.hooks.map(hook => (
              <div className="consensus-row" key={hook.id}>
                <strong>{hook.type}</strong>
                <code title={hook.id}>{short(hook.id)}</code>
                <span>{time(hook.triggerAt)}</span>
              </div>
            ))
          ) : (
            <p>No scheduled hooks.</p>
          )}
        </div>
      </section>
    </section>
  );
}
