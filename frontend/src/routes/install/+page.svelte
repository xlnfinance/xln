<script lang="ts">
	import {
		ArrowRight,
		Check,
		CircleAlert,
		Code2,
		ExternalLink,
		Globe2,
		LockKeyhole,
		MonitorDown,
		Puzzle,
		ShieldCheck,
		Smartphone,
		Terminal,
	} from 'lucide-svelte';

	import { getInstallReadinessSummary, INSTALL_CHANNELS } from '$lib/install/platforms';
	import './install-page.css';
	import './install-channels.css';
	import './install-release.css';

	const readiness = getInstallReadinessSummary(INSTALL_CHANNELS);
	const releaseSteps = [
		{
			index: '01',
			title: 'One signed release manifest',
			text: 'Build every artifact from one commit, publish hashes and signatures, and make the page consume that immutable manifest.',
		},
		{
			index: '02',
			title: 'CLI + desktop distribution',
			text: 'Publish the real Bun launcher, then ship signed and notarized macOS, Windows, and Linux Electron installers.',
		},
		{
			index: '03',
			title: 'TestFlight + Google Play',
			text: 'Configure production signing, entitlements, privacy metadata, deep-link tests, and staged store channels.',
		},
		{
			index: '04',
			title: 'Extension stores',
			text: 'Publish the keyless companion to Chrome and Edge, then port the same constrained surface to Firefox and Safari.',
		},
	] as const;
</script>

<svelte:head>
	<title>Install xln — every platform</title>
	<meta
		name="description"
		content="Choose how to run xln across web, terminal, desktop, mobile, and browser-extension surfaces."
	/>
	<meta property="og:title" content="Install xln — every platform" />
	<meta
		property="og:description"
		content="A transparent guide to every xln install path, its security boundary, and current release status."
	/>
</svelte:head>

<div class="install-page">
	<section class="install-hero" aria-labelledby="install-title">
		<div class="hero-copy">
			<p class="eyebrow"><span></span> Choose your trust boundary</p>
			<h1 id="install-title">xln, wherever<br /> you operate.</h1>
			<p class="hero-lede">
				Five ways to run the same wallet — with an honest account of what is usable today,
				what is only buildable, and what still needs signed distribution.
			</p>
			<div class="hero-actions">
				<a class="primary-action" href="/app">
					Open the web app <ArrowRight size={17} strokeWidth={1.8} />
				</a>
				<a class="text-action" href="#all-platforms">Compare all five</a>
			</div>
			<div class="readiness-strip" aria-label="Current distribution readiness">
				<div><strong>{readiness.total}</strong><span>delivery surfaces</span></div>
				<div><strong>{readiness.available}</strong><span>public now</span></div>
				<div><strong>{readiness.prepared}</strong><span>build previews</span></div>
				<div><strong>0</strong><span>signed downloads</span></div>
			</div>
		</div>

		<aside class="trust-card">
			<div class="trust-icon"><LockKeyhole size={28} strokeWidth={1.5} /></div>
			<p class="card-label">SECURITY MODEL</p>
			<h2>Installation is part of custody.</h2>
			<p>
				The web app keeps data and keys in your browser, but its code arrives from a server that
				can change. That mutable-code risk is fundamental to a server-loaded wallet.
			</p>
			<ul>
				<li><ShieldCheck size={16} /> Signed local builds can be pinned and inspected.</li>
				<li><CircleAlert size={16} /> Store, registry, and update channels remain trust boundaries.</li>
			</ul>
			<a href="#release-path">See the release path <ArrowRight size={15} /></a>
		</aside>
	</section>

	<section class="platform-section" id="all-platforms" aria-labelledby="platform-heading">
		<div class="section-heading">
			<div>
				<p class="eyebrow"><span></span> All delivery surfaces</p>
				<h2 id="platform-heading">Choose speed, portability, or stronger code pinning.</h2>
			</div>
			<p>Status describes distribution today — not how much source code exists.</p>
		</div>

		<div class="channel-grid">
			{#each INSTALL_CHANNELS as channel}
				<article
					class="channel-card"
					class:featured={channel.id === 'web'}
					data-status={channel.status}
					data-testid={`install-channel-${channel.id}`}
				>
					<header class="channel-header">
						<div class="channel-identity">
							<div class="channel-icon" aria-hidden="true">
								{#if channel.id === 'web'}<Globe2 size={25} strokeWidth={1.6} />{/if}
								{#if channel.id === 'cli'}<Terminal size={25} strokeWidth={1.6} />{/if}
								{#if channel.id === 'desktop'}<MonitorDown size={25} strokeWidth={1.6} />{/if}
								{#if channel.id === 'mobile'}<Smartphone size={25} strokeWidth={1.6} />{/if}
								{#if channel.id === 'extension'}<Puzzle size={25} strokeWidth={1.6} />{/if}
							</div>
							<div><span>{channel.index} · {channel.kicker}</span><h3>{channel.title}</h3></div>
						</div>
						<span class="status-badge">{channel.statusLabel}</span>
					</header>

					<p class="channel-summary">{channel.summary}</p>
					<div class="platform-list" aria-label={`${channel.title} platforms`}>
						{#each channel.platforms as platform}<span>{platform}</span>{/each}
					</div>

					{#if channel.command}
						<div class="command-preview" aria-label="Planned Bun command">
							<div><Code2 size={16} /><code>{channel.command}</code></div>
							<small>{channel.commandNote}</small>
						</div>
					{/if}

					<div class="trust-boundary">
						<LockKeyhole size={16} strokeWidth={1.7} />
						<p><strong>Trust boundary</strong>{channel.trustBoundary}</p>
					</div>

					<div class="tradeoffs">
						<div><h4>Why choose it</h4><ul>{#each channel.pros as item}<li><Check size={14} />{item}</li>{/each}</ul></div>
						<div><h4>Limits today</h4><ul class="limits">{#each channel.limits as item}<li><span>—</span>{item}</li>{/each}</ul></div>
					</div>

					<footer>
						<a href={channel.href} target={channel.href.startsWith('http') ? '_blank' : undefined} rel={channel.href.startsWith('http') ? 'noreferrer' : undefined}>
							{channel.action}
							{#if channel.href.startsWith('http')}<ExternalLink size={14} />{:else}<ArrowRight size={15} />{/if}
						</a>
					</footer>
				</article>
			{/each}
		</div>
	</section>

	<section class="release-section" id="release-path" aria-labelledby="release-heading">
		<div class="release-intro">
			<p class="eyebrow"><span></span> Distribution roadmap</p>
			<h2 id="release-heading">From buildable code to trustworthy installs.</h2>
			<p>
				A channel becomes “available” only when a user can obtain a versioned artifact and verify
				where it came from. Source presence alone is not a release.
			</p>
			<a href="https://github.com/xlnfinance/xln/blob/main/docs/platform-distribution-plan.md" target="_blank" rel="noreferrer">
				Read the full delivery plan <ExternalLink size={14} />
			</a>
		</div>
		<ol class="release-steps">
			{#each releaseSteps as step}
				<li><span>{step.index}</span><div><h3>{step.title}</h3><p>{step.text}</p></div></li>
			{/each}
		</ol>
	</section>

	<footer class="install-footer">
		<p><span class="brand-mark">xln</span> One codebase. Explicit trust boundaries.</p>
		<a href="https://github.com/xlnfinance/xln" target="_blank" rel="noreferrer">View source <ExternalLink size={14} /></a>
	</footer>
</div>
