import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const outDir = process.env.XLN_SVELTE_KIT_OUT_DIR || '.svelte-kit';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
		outDir,
		// Static adapter for GitHub Pages deployment
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			fallback: 'index.html',
			precompress: false,
			strict: true
		}),
		// Configure for SPA mode (single page app)
		prerender: {
			handleHttpError: 'warn',
			handleMissingId: 'warn'
		},
		// Set base path - empty for server deployment
		paths: {
			base: ''
		},
		alias: {
			$types: '../runtime/types.ts',
			'@xln/runtime': '../runtime',
			'@xln/brainvault': '../brainvault'
		}
	}
};

export default config;
