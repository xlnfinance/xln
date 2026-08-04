import { Component, type ErrorInfo, type ReactNode } from 'react';

export class OpsErrorBoundary extends Component<Readonly<{ children: ReactNode }>, Readonly<{ error: Error | null }>> {
  override state: Readonly<{ error: Error | null }> = Object.freeze({ error: null });

  static getDerivedStateFromError(error: Error): Readonly<{ error: Error }> {
    return Object.freeze({ error });
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('OPS_REACT_FATAL', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="ops-fatal" role="alert">
        <p>operator surface stopped</p>
        <h1>Fail loud. Preserve the evidence.</h1>
        <pre>{this.state.error.stack || this.state.error.message}</pre>
        <button type="button" onClick={() => window.location.reload()}>Reload ops surface</button>
      </main>
    );
  }
}
