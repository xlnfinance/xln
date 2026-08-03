import { Component, type ErrorInfo, type ReactNode } from 'react';

import { errorText, reportSiteError } from './error-surface';

type Props = Readonly<{ children: ReactNode }>;
type State = Readonly<{ error: string | null }>;

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: errorText(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportSiteError('react-boundary', error);
    console.error('[XLN_SITE_COMPONENT_STACK]', info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="site-fatal" role="alert">
        <p>xln site stopped</p>
        <h1>This page could not render.</h1>
        <pre>{this.state.error}</pre>
        <button type="button" onClick={() => window.location.reload()}>Reload page</button>
      </main>
    );
  }
}
