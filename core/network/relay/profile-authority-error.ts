/** A failed connection confers no profile authority; callers must reject without storing. */
export class ProfileAuthorityUnavailableError extends Error {
  constructor(authorityUrl: string, cause: Error) {
    super(`PROFILE_AUTHORITY_UNAVAILABLE:ECONNREFUSED:${authorityUrl}`, { cause });
    this.name = 'ProfileAuthorityUnavailableError';
  }
}
