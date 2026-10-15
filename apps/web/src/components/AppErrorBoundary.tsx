// Last line of defence: a render throw anywhere outside a PanelBoundary used
// to unmount the whole SPA and leave a blank page with the cause only in the
// browser console. This shows a recovery page instead and reports the error
// to Admin → Client errors.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { SPA_BASE_PATH } from '../lib/api';
import { reportClientError } from '../lib/client-errors';

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('page failed to render', error);
    reportClientError({ kind: 'app', error, componentStack: info.componentStack });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    // Plain links, not router navigation: the router tree is what failed,
    // and a full load is the reliable way back to a clean state.
    return (
      <div className="min-h-dvh flex items-center justify-center bg-paper p-4">
        <div className="max-w-md text-center">
          <h1 className="font-display text-2xl mb-2">This page could not be displayed</h1>
          <p className="text-sm text-ink/70 mb-6">
            Something in it failed to load. The problem has been reported to your administrator.
          </p>
          <div className="flex flex-wrap justify-center gap-3 text-sm">
            <a
              href={window.location.href}
              className="px-3 py-1.5 border border-ink/20 rounded hover:bg-ink/5"
            >
              Try again
            </a>
            <a
              href={`${SPA_BASE_PATH}/research`}
              className="px-3 py-1.5 border border-ink/20 rounded hover:bg-ink/5"
            >
              Back to research
            </a>
          </div>
        </div>
      </div>
    );
  }
}
