import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const prerender = false;

const allowedViews = new Set([
  'home',
  'settings',
  'docs',
  'wallet',
  'brainvault',
  'graph-3d',
  'graph3d',
  'graph-2d',
  'graph2d',
  'panels',
  'terminal'
]);

export const load: PageLoad = ({ params }) => {
  const slug = params.view?.toLowerCase() ?? '';

  if (!allowedViews.has(slug)) {
    throw error(404, 'Not found');
  }

  return { slug };
};
