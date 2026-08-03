import { Component, type ErrorInfo, type ReactNode } from 'react';

type State = Readonly<{ error: Error | null }>;

export class DocsErrorBoundary extends Component<Readonly<{ children: ReactNode }>, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('REACT_DOCS_RENDER_FAILED', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="docs-fatal" role="alert">
        <p>Documentation failed loudly.</p>
        <pre>{this.state.error.message}</pre>
        <button type="button" onClick={() => window.location.reload()}>Reload docs</button>
      </main>
    );
  }
}
