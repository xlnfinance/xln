import { describe, expect, test } from 'bun:test';

import {
  isResetDbConfirmationValid,
  readResetDbCookie,
  RESET_CONFIRM_COOKIE,
} from '../../frontend/src/lib/utils/resetDbGuard';

const nonce = '0123456789abcdef0123456789abcdef';

describe('/resetdb confirmation guard', () => {
  test('rejects direct navigation without matching query and cookie confirmation', () => {
    expect(isResetDbConfirmationValid(new URL('http://localhost/resetdb'), null)).toBe(false);
    expect(isResetDbConfirmationValid(
      new URL(`http://localhost/resetdb?confirm=${nonce}`),
      null,
    )).toBe(false);
    expect(isResetDbConfirmationValid(
      new URL(`http://localhost/resetdb?confirm=${nonce}`),
      `${RESET_CONFIRM_COOKIE}=wrong`,
    )).toBe(false);
  });

  test('accepts a matching reset nonce only', () => {
    expect(readResetDbCookie(`foo=bar; ${RESET_CONFIRM_COOKIE}=${nonce}; theme=dark`)).toBe(nonce);
    expect(isResetDbConfirmationValid(
      new URL(`http://localhost/resetdb?confirm=${nonce}`),
      `foo=bar; ${RESET_CONFIRM_COOKIE}=${nonce}; theme=dark`,
    )).toBe(true);
  });
});
