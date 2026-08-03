import { useState } from 'react';

import { INSTALL_CHANNELS, LOCAL_RUNTIME_COMMAND } from '../data/install';

const CHANNEL_ICONS = { cli: '›_', web: '◎', desktop: '▱', mobile: '▯', extension: '◇' } as const;

export default function InstallPage() {
  const [copied, setCopied] = useState(false);
  const copyCommand = async (): Promise<void> => {
    await navigator.clipboard.writeText(LOCAL_RUNTIME_COMMAND);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_400);
  };

  return (
    <div className="install-page">
      <section className="hero">
        <p className="eyebrow">xln finance / install</p>
        <h1>Own the<br /><em>runtime.</em></h1>
        <p className="lede">Use any screen. Keep the financial machine under your control.</p>
        <div className="command" data-testid="install-primary-command">
          <div><span>$</span><code>{LOCAL_RUNTIME_COMMAND}</code></div>
          <button type="button" onClick={() => void copyCommand()} aria-label="Copy install command">
            {copied ? '✓' : 'Copy'}
          </button>
        </div>
        <div className="runtime-flow" aria-label="Local runtime architecture">
          <span>browser</span><i>↔</i><span>localhost:8080</span><i>↔</i><strong>persistent xln runtime</strong>
        </div>
      </section>

      <section className="channels" aria-labelledby="channels-title">
        <header><p className="eyebrow">Every surface</p><h2 id="channels-title">One app. Five ways in.</h2></header>
        <div className="channel-grid">
          {INSTALL_CHANNELS.map(channel => (
            <article className={channel.id === 'cli' ? 'primary' : undefined} data-testid={`install-channel-${channel.id}`} key={channel.id}>
              <div className="card-top"><div className="icon" aria-hidden="true">{CHANNEL_ICONS[channel.id]}</div><span>{channel.label}</span></div>
              <h3>{channel.title}</h3><p className="summary">{channel.summary}</p>
              <div className="platforms">{channel.platforms.join(' · ')}</div>
              {channel.command ? (
                <button className="mini-command" type="button" onClick={() => void copyCommand()}>
                  <code>{channel.command}</code><span>{copied ? '✓' : 'Copy'}</span>
                </button>
              ) : null}
              <dl><div><dt>+</dt><dd>{channel.benefit}</dd></div><div className="tradeoff"><dt>−</dt><dd>{channel.tradeoff}</dd></div></dl>
              <a href={channel.href} target={channel.href.startsWith('http') ? '_blank' : undefined} rel="noreferrer">
                {channel.action}<span aria-hidden="true">↗</span>
              </a>
            </article>
          ))}
        </div>
      </section>
      <footer><span>xln finance</span><span>local-first · open source · AGPL-3.0</span></footer>
    </div>
  );
}
