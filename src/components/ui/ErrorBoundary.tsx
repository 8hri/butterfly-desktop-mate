import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Rendered instead of the children when loading fails. */
  fallback: ReactNode;
}

interface State {
  failed: boolean;
}

/**
 * Keeps a failed asset load from leaving the user on a blank screen.
 * The most likely failure is the butterfly GLB being missing or corrupt,
 * which is exactly the case this boundary exists to explain calmly.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("The experience failed to load:", error, info.componentStack);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
