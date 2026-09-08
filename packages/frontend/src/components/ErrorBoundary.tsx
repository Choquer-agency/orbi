import { Component, type ReactNode } from 'react';
import { track } from '../lib/telemetry';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /** Label recorded with the crash so we know WHICH boundary caught it. */
  name?: string;
  /**
   * Called when a caught error looks recoverable by resetting app state
   * (currently: a selected id the server rejects). Returning true means the
   * boundary silently retries instead of showing a crash screen.
   */
  onRecoverableError?: (error: Error) => boolean;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error('Orbi UI crashed', { error, componentStack: info.componentStack });
    try {
      track('crash', {
        boundary: this.props.name ?? 'root',
        message: error?.message,
        stack: error?.stack,
      });
    } catch {
      /* never let reporting mask the original error */
    }
    // Self-healing path: a stale or foreign id (a link from another app, an
    // old notification) makes every query for that record fail argument
    // validation, which used to blank the WHOLE app behind "Something went
    // wrong". Let the owner clear the bad selection and carry on instead.
    if (this.props.onRecoverableError?.(error)) {
      this.setState({ hasError: false, error: null });
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex h-full items-center justify-center p-8">
          <div className="text-center">
            <p className="text-sm font-medium text-text-primary">Something went wrong</p>
            <p className="mt-1 text-xs text-text-tertiary">
              {this.state.error?.message || 'An unexpected error occurred'}
            </p>
            <div className="mt-3 flex items-center justify-center gap-2">
              <button
                onClick={() => this.setState({ hasError: false, error: null })}
                className="rounded-lg bg-primary px-3 py-1.5 text-xs text-white transition-colors hover:bg-primary/90"
              >
                Try again
              </button>
              <button
                onClick={() => window.location.reload()}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface"
              >
                Reload
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
