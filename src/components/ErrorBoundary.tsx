import { Component, ReactNode, ErrorInfo } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  label?: string;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary: ${this.props.label ?? "unknown"}]`, error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center gap-3 py-6 text-zinc-500 text-sm border-b border-zinc-800">
          <AlertTriangle size={16} className="text-orange-500 shrink-0" />
          <span>
            {this.props.label ? `${this.props.label} failed to render` : "Something went wrong"}
            {" — "}
            <button
              className="text-orange-400 hover:text-orange-300 underline underline-offset-2"
              onClick={() => this.setState({ hasError: false })}
            >
              retry
            </button>
          </span>
        </div>
      );
    }

    return this.props.children;
  }
}
