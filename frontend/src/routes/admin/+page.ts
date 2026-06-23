import { redirect } from '@sveltejs/kit';

export const prerender = false;

export function load() {
  throw redirect(308, '/health');
}
