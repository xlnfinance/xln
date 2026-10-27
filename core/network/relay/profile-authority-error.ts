/** A failed connection confers no profile authority; callers must reject without storing. */
export class ProfileAuthorityUnavailableError extends Error {
  constructor(authorityUrl: string, code: 'ECONNREFUSED' | 'ECONNRESET', cause: Error) {
    super(`PROFILE_AUTHORITY_UNAVAILABLE:${code}:${authorityUrl}`, { cause });
    this.name = 'ProfileAuthorityUnavailableError';
  }
}
