import { Component, type ErrorInfo, type ReactNode } from 'react';
import { log } from '../store/log-store';

/**
 * Last line of defence around the whole app. Panels have their own
 * PanelErrorBoundary; the toolbar, status bar, toasts and overlays did not,
 * so one throw there unmounted everything and left a blank window.
 *
 * "Reload interface" remounts the React tree only. The stores are module
 * state, so open boards, selection and settings are still there afterwards;
 * "Reload page" is the full restart.
 */
export class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.ui.error(`App crashed: ${error.message}`, error, info.componentStack ?? '');
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="panel-error-boundary root-error-boundary" data-testid="root-error-boundary">
        <div className="panel-error-title">BoardRipper hit an error</div>
        <div className="panel-error-message">{error.message || 'An unexpected error occurred.'}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="panel-error-reset" onClick={() => this.setState({ error: null })}>Reload interface</button>
          <button className="panel-error-reset" onClick={() => window.location.reload()}>Reload page</button>
        </div>
      </div>
    );
  }
}
