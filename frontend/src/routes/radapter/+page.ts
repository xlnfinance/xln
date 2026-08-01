import { error, redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ url }) => {
  if (url.search) {
    throw error(400, 'REMOTE_RUNTIME_QUERY_BOOTSTRAP_FORBIDDEN');
  }
  throw redirect(307, '/app');
};
