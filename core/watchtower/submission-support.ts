import { isTronChainId } from '../jurisdiction/adapter/chain-ids';

class WatchtowerUnsupportedChainError extends Error {
  readonly code = 'WATCHTOWER_TRON_SUBMISSION_UNSUPPORTED';
  constructor() {
    super('WATCHTOWER_TRON_SUBMISSION_UNSUPPORTED: Native TRON watchtower submission is unavailable.');
    this.name = 'WatchtowerUnsupportedChainError';
  }
}

/** An appointment promises executable protection; ethers signing cannot submit a native TRON transaction. */
export const assertWatchtowerSubmissionSupported = (chainId: number): void => {
  if (isTronChainId(chainId)) throw new WatchtowerUnsupportedChainError();
};
