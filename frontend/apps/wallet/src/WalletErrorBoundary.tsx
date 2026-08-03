import { Component, type ErrorInfo, type ReactNode } from 'react';

import { reportWalletError, walletErrorText } from './error-surface';

type Props = Readonly<{ children: ReactNode }>;
type State = Readonly<{ error: string | null }>;

export class WalletErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: walletErrorText(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportWalletError('react-boundary', error);
    console.error('[XLN_WALLET_COMPONENT_STACK]', info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="wallet-fatal" role="alert">
        <p className="wallet-eyebrow">wallet stopped</p>
        <h1>This session could not render safely.</h1>
        <pre>{this.state.error}</pre>
        <button type="button" onClick={() => window.location.reload()}>Reload wallet</button>
      </main>
    );
  }
}
