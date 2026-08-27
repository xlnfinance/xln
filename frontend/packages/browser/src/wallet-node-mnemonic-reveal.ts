export type WalletNodeMnemonicRevealOperation<Recovery> = Readonly<{
  reveal: () => Promise<Recovery>;
  isCurrent: () => boolean;
}>;

export type WalletNodeMnemonicRevealOutcome<Recovery> =
  | Readonly<{ status: 'completed'; recovery: Recovery }>
  | Readonly<{ status: 'failed'; message: string }>
  | Readonly<{ status: 'cancelled'; latest: boolean }>;

const revealErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class WalletNodeMnemonicRevealCoordinator<Recovery> {
  private generation = 0;

  readonly run = async (
    operation: WalletNodeMnemonicRevealOperation<Recovery>,
  ): Promise<WalletNodeMnemonicRevealOutcome<Recovery>> => {
    const generation = ++this.generation;
    try {
      const recovery = await operation.reveal();
      const latest = generation === this.generation;
      return latest && operation.isCurrent()
        ? { status: 'completed', recovery }
        : { status: 'cancelled', latest };
    } catch (error) {
      const latest = generation === this.generation;
      return latest && operation.isCurrent()
        ? { status: 'failed', message: revealErrorMessage(error) }
        : { status: 'cancelled', latest };
    }
  };

  readonly invalidate = (): void => {
    this.generation += 1;
  };
}
