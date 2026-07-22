<script lang="ts">
	import {
		ArrowUpRight,
		Check,
		Chrome,
		Copy,
		Globe2,
		Laptop,
		Smartphone,
		Terminal,
	} from 'lucide-svelte';
	import { INSTALL_CHANNELS, LOCAL_RUNTIME_COMMAND } from '$lib/install/platforms';
	import './install-page.css';

	let copied = false;
	const copyCommand = async (): Promise<void> => {
		await navigator.clipboard.writeText(LOCAL_RUNTIME_COMMAND);
		copied = true;
		setTimeout(() => copied = false, 1400);
	};
</script>

<svelte:head>
	<title>Install xln finance</title>
	<meta name="description" content="Run xln on web, desktop, mobile, Chrome, or as a persistent local runtime." />
</svelte:head>

<main class="install-page">
	<nav aria-label="Install navigation">
		<a class="wordmark" href="/">xln</a>
		<a class="source-link" href="https://github.com/xlnfinance/xln" target="_blank" rel="noreferrer">
			Source <ArrowUpRight size={14} />
		</a>
	</nav>

	<section class="hero">
		<p class="eyebrow">xln finance / install</p>
		<h1>Own the<br /><em>runtime.</em></h1>
		<p class="lede">Use any screen. Keep the financial machine under your control.</p>

		<div class="command" data-testid="install-primary-command">
			<div><span>$</span><code>{LOCAL_RUNTIME_COMMAND}</code></div>
			<button type="button" on:click={copyCommand} aria-label="Copy install command">
				{#if copied}<Check size={17} />{:else}<Copy size={17} />{/if}
			</button>
		</div>
		<div class="runtime-flow" aria-label="Local runtime architecture">
			<span>browser</span><i>↔</i><span>localhost:8080</span><i>↔</i><strong>persistent xln runtime</strong>
		</div>
	</section>

	<section class="channels" aria-labelledby="channels-title">
		<header>
			<p class="eyebrow">Every surface</p>
			<h2 id="channels-title">One app. Five ways in.</h2>
		</header>

		<div class="channel-grid">
			{#each INSTALL_CHANNELS as channel}
				<article class:primary={channel.id === 'cli'} data-testid={`install-channel-${channel.id}`}>
					<div class="card-top">
						<div class="icon" aria-hidden="true">
							{#if channel.id === 'cli'}<Terminal size={21} />{/if}
							{#if channel.id === 'web'}<Globe2 size={21} />{/if}
							{#if channel.id === 'desktop'}<Laptop size={21} />{/if}
							{#if channel.id === 'mobile'}<Smartphone size={21} />{/if}
							{#if channel.id === 'extension'}<Chrome size={21} />{/if}
						</div>
						<span>{channel.label}</span>
					</div>
					<h3>{channel.title}</h3>
					<p class="summary">{channel.summary}</p>
					<div class="platforms">{channel.platforms.join(' · ')}</div>

					{#if channel.command}
						<button class="mini-command" type="button" on:click={copyCommand}>
							<code>{channel.command}</code>{#if copied}<Check size={14} />{:else}<Copy size={14} />{/if}
						</button>
					{/if}

					<dl>
						<div><dt>+</dt><dd>{channel.benefit}</dd></div>
						<div class="tradeoff"><dt>−</dt><dd>{channel.tradeoff}</dd></div>
					</dl>
					<a href={channel.href} target={channel.href.startsWith('http') ? '_blank' : undefined} rel="noreferrer">
						{channel.action}<ArrowUpRight size={15} />
					</a>
				</article>
			{/each}
		</div>
	</section>

	<footer><span>xln finance</span><span>local-first · open source · AGPL-3.0</span></footer>
</main>
