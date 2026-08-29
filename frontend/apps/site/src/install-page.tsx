import { useEffect, useRef, useState } from 'react';

import { Arrow, SiteFooter, SiteShell } from './site-shell';
import { INSTALL_CHANNELS, LOCAL_RUNTIME_COMMAND, type InstallChannel } from './site-model';

type CopyState = 'idle' | 'copied' | 'error';

function CopyCommand({ compact = false }: Readonly<{ compact?: boolean }>) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const copyCommand = async (): Promise<void> => {
    if (!navigator.clipboard) {
      setCopyState('error');
      throw new Error('INSTALL_CLIPBOARD_UNAVAILABLE');
    }
    try {
      await navigator.clipboard.writeText(LOCAL_RUNTIME_COMMAND);
      setCopyState('copied');
      window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopyState('idle'), 1600);
    } catch (error) {
      setCopyState('error');
      throw error;
    }
  };

  return (
    <div className={compact ? 'copy-command is-compact' : 'copy-command'} data-testid="install-primary-command">
      <span aria-hidden="true">$</span>
      <code>{LOCAL_RUNTIME_COMMAND}</code>
      <button type="button" onClick={() => void copyCommand()} aria-label="Copy install command">
        {copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Failed' : 'Copy'}
      </button>
      {copyState === 'error' ? <p role="alert">Clipboard access failed. Select the command manually.</p> : null}
    </div>
  );
}

function RuntimeRail() {
  return (
    <div className="runtime-rail" aria-label="Local xln runtime architecture">
      <div><span>01</span><strong>browser</strong><small>interface</small></div>
      <i aria-hidden="true"><b /></i>
      <div><span>02</span><strong>localhost:8080</strong><small>private boundary</small></div>
      <i aria-hidden="true"><b /></i>
      <div><span>03</span><strong>xln runtime</strong><small>persistent state</small></div>
    </div>
  );
}

function ChannelRow({ channel }: Readonly<{ channel: InstallChannel }>) {
  const isExternal = channel.href.startsWith('http');
  return (
    <article className={channel.id === 'cli' ? 'channel-row is-primary' : 'channel-row'} data-testid={`install-channel-${channel.id}`}>
      <div className="channel-index"><span>{channel.sequence}</span><small>{channel.label}</small></div>
      <div className="channel-name"><h3>{channel.title}</h3><p>{channel.platforms.join(' · ')}</p></div>
      <div className="channel-detail">
        <p>{channel.summary}</p>
        <dl><div><dt>+</dt><dd>{channel.benefit}</dd></div><div><dt>−</dt><dd>{channel.tradeoff}</dd></div></dl>
      </div>
      <a href={channel.href} target={isExternal ? '_blank' : undefined} rel={isExternal ? 'noreferrer' : undefined}>
        {channel.action} <Arrow diagonal={isExternal} />
      </a>
    </article>
  );
}

function InstallHero() {
  return (
    <section className="install-hero">
      <div>
        <p className="kicker">xln / install</p>
        <h1>Own the<br /><em>runtime.</em></h1>
      </div>
      <p className="install-lede">Use any screen. Keep the financial machine under your control.</p>
      <CopyCommand />
      <RuntimeRail />
    </section>
  );
}

export function InstallPage() {
  return (
    <SiteShell activeRoute="/install">
      <main>
        <InstallHero />
        <section className="channel-section" aria-labelledby="channel-title">
          <header><p className="kicker">Every surface</p><h2 id="channel-title">One app.<br />Five ways in.</h2></header>
          <div className="channel-list">{INSTALL_CHANNELS.map((channel) => <ChannelRow key={channel.id} channel={channel} />)}</div>
        </section>
        <section className="install-final">
          <div><p className="kicker">Recommended path</p><h2>Persistent.<br />Local.<br /><em>Yours.</em></h2></div>
          <div><p>The local runtime keeps running after the browser closes and gives your local wallet full administrative control.</p><CopyCommand compact /></div>
        </section>
      </main>
      <SiteFooter />
    </SiteShell>
  );
}
