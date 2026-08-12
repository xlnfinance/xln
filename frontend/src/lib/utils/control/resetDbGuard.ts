export const RESET_CONFIRM_COOKIE = 'xln_reset_confirm';

export function readResetDbCookie(header: string | null, name = RESET_CONFIRM_COOKIE): string {
  const prefix = `${name}=`;
  return String(header || '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(prefix))
    ?.slice(prefix.length) || '';
}

export function isResetDbConfirmationValid(url: URL, cookieHeader: string | null): boolean {
  const queryConfirm = String(url.searchParams.get('confirm') || '').trim();
  if (!/^[a-f0-9]{32}$/i.test(queryConfirm)) return false;
  return readResetDbCookie(cookieHeader) === queryConfirm;
}
