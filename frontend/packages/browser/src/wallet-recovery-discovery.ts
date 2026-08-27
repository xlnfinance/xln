export type WalletRecoveryDiscoveryRequest = Readonly<{
  seed: string;
  runtimeId: string;
}>;

export type WalletRecoveryDiscoveryDependencies<Request, Discovery> = Readonly<{
  discover: (request: Request) => Promise<Discovery>;
}>;

export type WalletRecoveryDiscoveryOutcome<Discovery> =
  | Readonly<{ status: 'completed'; discovery: Discovery }>
  | Readonly<{ status: 'failed'; message: string }>
  | Readonly<{ status: 'cancelled' }>;

const recoveryDiscoveryErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class WalletRecoveryDiscoveryCoordinator<Request, Discovery> {
  private generation = 0;

  constructor(
    private readonly dependencies: WalletRecoveryDiscoveryDependencies<Request, Discovery>,
  ) {}

  readonly run = async (
    request: Request,
  ): Promise<WalletRecoveryDiscoveryOutcome<Discovery>> => {
    const generation = ++this.generation;
    try {
      const discovery = await this.dependencies.discover(request);
      return generation === this.generation
        ? { status: 'completed', discovery }
        : { status: 'cancelled' };
    } catch (error) {
      return generation === this.generation
        ? { status: 'failed', message: recoveryDiscoveryErrorMessage(error) }
        : { status: 'cancelled' };
    }
  };

  readonly invalidate = (): void => {
    this.generation += 1;
  };
}
