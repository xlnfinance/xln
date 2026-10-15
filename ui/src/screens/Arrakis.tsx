import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, ChevronRight, Globe2, Landmark, Orbit, ShieldCheck, Sparkles } from 'lucide-react';
import './arrakis.css';

import { actions, type World } from './arrakis-model';

const endpoint = 'http://127.0.0.1:8086/arrakis';
const amount = (value: string, decimals = 0) =>
  new Intl.NumberFormat('en-US', {
    maximumFractionDigits: decimals ? 4 : 0,
    notation: Number(value) / 10 ** decimals >= 1_000_000 ? 'compact' : 'standard',
  }).format(Number(value) / 10 ** decimals);

export function Arrakis() {
  const [world, setWorld] = useState<World | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const response = await fetch(endpoint);
        if (!response.ok) throw new Error(`Arrakis service: ${response.status}`);
        const next = (await response.json()) as World;
        if (alive) {
          setWorld(next);
          setError('');
        }
      } catch (failure) {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure));
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  const act = async (action = world?.next) => {
    if (!action || sending) return;
    setSending(true);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: action, runtimeId: world?.runtimeId }),
      });
      const next = (await response.json()) as World;
      setWorld(next);
      if (!response.ok) throw new Error(next.error || 'The operation did not complete.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSending(false);
    }
  };
  const step = actions.find(action => action.id === world?.next) ?? actions[0];
  const finished = Boolean(world && !world.next);
  const investor = world?.entities.find(entity => entity.role === 'investor');
  const company = world?.entities.find(entity => entity.role === 'company');
  const control = investor?.balances[1];
  const settledPercent = control ? Number((BigInt(control.reserve) * 100n) / 100_000_000_000n) : 0;
  const controlled = company?.threshold === '1';
  const busy = sending || Boolean(world?.busy);
  return (
    <div className="arrakis">
      <header className="ar-header">
        <a className="ar-brand" href="/">
          <Orbit size={25} /> XLN <span>/</span> ARRAKIS
        </a>
        <span className="ar-network">
          <i /> Private local simnet
        </span>
        <a className="ar-wallet" href="/">
          Open wallet <ArrowUpRight size={15} />
        </a>
      </header>
      <main className="ar-main">
        <div className="ar-intro">
          <span className="ar-eyebrow">An economy you can hold</span>
          <h1>
            Trade the asset.
            <br />
            <em>Own the future.</em>
          </h1>
          <p>
            Spice moves. Shares change hands.
            <br />
            Control follows settled ownership.
          </p>
          <div className="ar-orbit" aria-hidden="true">
            <div />
            <span>SPICE</span>
          </div>
        </div>
        <div className="ar-disclaimer">
          <Globe2 size={16} />
          <span>
            Experimental world · no real money · all actors operated locally. Browser reload keeps this session;
            restarting the demo server creates a new world.
          </span>
        </div>
        <section className="ar-layout">
          <aside className="ar-journey">
            <div className="ar-label">
              YOUR JOURNEY{' '}
              <span>
                {world?.completed.length ?? 0} / {actions.length}
              </span>
            </div>
            {actions.map((action, index) => (
              <div
                key={action.id}
                className={`ar-milestone ${world?.completed.includes(action.id) ? 'done' : world?.next === action.id ? 'current' : ''}`}
              >
                <span>
                  {world?.completed.includes(action.id) ? <Check size={14} /> : String(index + 1).padStart(2, '0')}
                </span>
                {action.label}
              </div>
            ))}
          </aside>
          <section className="ar-action" aria-live="polite">
            <span className="ar-eyebrow">
              {finished ? 'A complete company lifecycle' : `CHAPTER ${actions.indexOf(step) + 1} / 8`}
            </span>
            <h2>{finished ? 'You traded. You governed. It executed.' : step.title}</h2>
            <p>
              {finished
                ? 'Spice payment, share purchase, settlement, board change, treasury transfer and resale are committed in this world. Inspect the Account balances and governing board below.'
                : step.text}
            </p>
            {finished && (
              <button className="ar-primary" disabled={busy} onClick={() => void act('new')}>
                Start a new local world <ChevronRight size={19} />
              </button>
            )}
            {!finished && (
              <button
                className="ar-primary"
                onClick={() => void act()}
                disabled={!world || busy || Boolean(world.error)}
              >
                {busy ? `Committing ${world?.busy ?? step.id}…` : step.button}
                {!busy && <ChevronRight size={19} />}
              </button>
            )}
            <small>{finished ? `Runtime frame ${world?.height} · all eight steps complete` : step.detail}</small>
            {(error || world?.error) && (
              <div className="ar-error" role="alert">
                {error || world?.error}
                {!world && (
                  <p>
                    Start the local world with <code>bun run demo:arrakis</code>, then this page reconnects
                    automatically.
                  </p>
                )}
              </div>
            )}
          </section>
        </section>
        <section className="ar-portfolio">
          <div className="ar-label">
            HOUSE MERIDIAN <span>YOUR ENTITY</span>
          </div>
          <div className="ar-assets">
            {(world?.tokens.length
              ? world.tokens
              : [
                  { id: 0, symbol: 'SPICE', decimals: 6 },
                  { id: 1, symbol: 'SIR.CONTROL', decimals: 0 },
                  { id: 2, symbol: 'SIR.DIVIDEND', decimals: 0 },
                ]
            ).map((token, index) => (
              <div className="ar-asset" key={token.id}>
                <span className={`ar-coin coin-${index}`}>{index ? 'S' : '✧'}</span>
                <div>
                  <label>{token.symbol}</label>
                  <strong>{amount(investor?.balances[index]?.net ?? '0', token.decimals)}</strong>
                  <small>
                    {index === 0
                      ? 'Test currency · not dollar-backed'
                      : index === 1
                        ? 'Net economic holding'
                        : 'Distinct share class · no automated payouts'}
                  </small>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="ar-company-grid">
          <article className="ar-company">
            <div className="ar-company-top">
              <span className="ar-company-mark">
                <Sparkles size={28} />
              </span>
              <div>
                <span className="ar-eyebrow">HARVESTING · REGISTERED ENTITY</span>
                <h2>Sirocco</h2>
              </div>
              <span className="ar-pill">{controlled ? 'Your board' : '2-of-3 board'}</span>
            </div>
            <p>Trade CONTROL to gain voting power. Trade DIVIDEND as a separate economic share.</p>
            <div className="ar-ownership">
              <span>Your settled voting power</span>
              <strong>{settledPercent}%</strong>
            </div>
            <div className="ar-control-bar" aria-label={`${settledPercent}% settled control`}>
              <i style={{ width: `${settledPercent}%` }} />
              <b style={{ left: '50%' }} />
            </div>
            <div className="ar-scale">
              <span>0%</span>
              <span>Majority requires more than 50%</span>
              <span>100%</span>
            </div>
            <div className="ar-board">
              <ShieldCheck size={21} />
              <div>
                <strong>{controlled ? '1 signature · your authority' : '2 signatures · 3 directors'}</strong>
                <small>
                  {controlled
                    ? 'The successor board is installed in Entity state and the EVM.'
                    : 'You begin as a minority director, not an outside attacker.'}
                </small>
              </div>
            </div>
            <code className="ar-id">{company?.id ?? 'Entity registers when you launch'}</code>
          </article>
          <article className="ar-market">
            <div className="ar-label">
              <Landmark size={16} /> ARRAKIS EXCHANGE
            </div>
            <h2>
              One market.
              <br />
              Bilateral settlement.
            </h2>
            <div className="ar-quote">
              <span>CONTROL / SPICE</span>
              <strong>
                0.0001 <small>SPICE / share</small>
              </strong>
            </div>
            <div className="ar-order">
              <span>Initial offering</span>
              <b>60B CONTROL</b>
            </div>
            <div className="ar-order">
              <span>Price before fees</span>
              <b>6M SPICE</b>
            </div>
            <div className="ar-order">
              <span>DIVIDEND ask</span>
              <b>100 shares · 0.01 SPICE</b>
            </div>
            <p>
              The hub matches orders. Each party keeps its own signed Account. A claim above collateral remains
              unsecured.
            </p>
          </article>
        </section>
        {world && world.entities.length > 0 && (
          <details className="ar-evidence">
            <summary>
              Inspect committed balances & board evidence <span>FRAME {world.height}</span>
            </summary>
            <p>
              Net = reserve + Account collateral entitlement + unsecured receivable − debt. Unused credit is excluded.
              Amounts below are exact token units.
            </p>
            {world.entities.map(entity => (
              <div key={String(entity.role)} className="ar-evidence-entity">
                <h3>
                  {String(entity.name)}{' '}
                  <small>
                    Entity frame {entity.height} · threshold {entity.threshold}/{entity.validators.length}
                  </small>
                </h3>
                <div className="ar-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th>Reserve</th>
                        <th>Secured claim</th>
                        <th>Unsecured claim</th>
                        <th>Debt</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entity.balances.map((balance, index) => (
                        <tr key={balance.tokenId}>
                          <td>{world.tokens[index]?.symbol}</td>
                          <td>{balance.reserve}</td>
                          <td>{balance.secured}</td>
                          <td>{balance.receivable}</td>
                          <td>{balance.debt}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <code>{entity.validators.join(' · ')}</code>
              </div>
            ))}
          </details>
        )}
        <footer className="ar-footer">
          <span>XLN · SIGNED RELATIONSHIPS, EXECUTABLE OWNERSHIP</span>
          <span>Experimental demo · not a mainnet release</span>
        </footer>
      </main>
    </div>
  );
}
