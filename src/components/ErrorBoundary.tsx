import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button } from '@capra/core';

export function ErrorFallback({ error }: { error: Error }) {
  return (
    <div>
      <Alert appearance="danger" title="This page hit an error">{error.message}</Alert>
      <div className="row">
        <Button onClick={() => window.location.reload()}>Reload page</Button>
        <Link to="/">Go to Overview</Link>
      </div>
    </div>
  );
}

interface Props { children?: ReactNode; error?: Error | null }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: this.props.error ?? null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (this.state.error) return <ErrorFallback error={this.state.error} />;
    return this.props.children;
  }
}
