import { writable } from 'svelte/store';

// Track if we're showing the landing page (which has its own language switcher)
export const showingLandingPage = writable(true);
