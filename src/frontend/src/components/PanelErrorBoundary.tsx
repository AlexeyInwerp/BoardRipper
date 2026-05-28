import { Component, type ErrorInfo, type ReactNode } from 'react';
import { log } from '../store/log-store';

interface PanelErrorBoundaryProps {
  /** Human label used in the fallback + the log line (e.g. the panel name). */
  label?: string;
  children: ReactNode;
}

interface PanelErrorBoundaryState {
  error: Error | null;
}

/**
 * Per-panel error boundary. A single bad board file (or any render-time throw
 * inside one panel) must NOT white-screen the whole app — without this, an
 * uncaught exception in one Dockview panel unmounts the entire React tree.
 *
 * Wrap each panel component in App.tsx with this. On a throw it logs through
 * the scoped UI logger and renders a small "this panel crashed — reload"
 * fallback with a reset button that clears the error and re-mounts children.
 */
export class PanelErrorBoundary extends Component<
  PanelErrorBoundaryProps,
  PanelErrorBoundaryState
> {
  state: PanelErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): PanelErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const where = this.props.label ? ` in panel '${this.props.label}'` : '';
    log.ui.error(
      `Panel crashed${where}: ${error.message}`,
      error,
      info.componentStack ?? '',
    );
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="panel-error-boundary" data-testid="panel-error-boundary">
          <div className="panel-error-title">This panel crashed</div>
          <div className="panel-error-message">
            {this.props.label ? `${this.props.label}: ` : ''}
            {this.state.error.message || 'An unexpected error occurred while rendering this panel.'}
          </div>
          <button className="panel-error-reset" onClick={this.reset}>
            Reload panel
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
