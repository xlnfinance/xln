import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
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
		// Set base path for GitHub Pages deployment
		paths: {
			base: process.env.NODE_ENV === 'production' ? '/xln' : ''
		}
	}
};

export default config;
