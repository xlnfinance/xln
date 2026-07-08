import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ url }) => {
  const target = new URL('/app', url.origin);
  const wsUrl = url.searchParams.get('ws') || url.searchParams.get('runtimeWs') || '';
  const token = url.searchParams.get('token') || url.searchParams.get('key') || url.searchParams.get('auth') || '';
  if (wsUrl) {
    target.searchParams.set('runtime', 'remote');
    target.searchParams.set('ws', wsUrl);
  }
  if (token) target.searchParams.set('token', token);
  target.hash = 'accounts';
  throw redirect(307, `${target.pathname}${target.search}${target.hash}`);
};
