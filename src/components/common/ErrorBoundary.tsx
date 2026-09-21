import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last-resort catch for render/lifecycle errors. Without this, any
 * uncaught exception below <App> unmounts the whole React tree and leaves
 * a blank white window with no indication of what happened.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="app-crash">
        <h1>Something went wrong</h1>
        <p>{error.message}</p>
        <pre className="app-crash__stack">{error.stack}</pre>
        <button type="button" onClick={() => this.setState({ error: null })}>
          Try to continue
        </button>
      </div>
    );
  }
}
