import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-black flex flex-col items-center justify-center text-white p-6 relative overflow-hidden">
          {/* Background grid */}
          <div className="absolute inset-0 bg-grid-white/[0.02] bg-[size:30px_30px] pointer-events-none" />
          
          <div className="relative z-10 max-w-md w-full text-center space-y-6">
            <div className="space-y-2">
              <h1 className="text-3xl font-bold bg-gradient-to-r from-red-400 to-pink-500 bg-clip-text text-transparent">
                Something went wrong
              </h1>
              <p className="text-neutral-400 text-sm">
                An unexpected error occurred in the application view.
              </p>
            </div>

            <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-left">
              <p className="text-xs text-red-400 font-mono leading-relaxed break-all">
                {this.state.error?.toString() || "Unknown error"}
              </p>
            </div>

            <button
              onClick={() => window.location.reload()}
              className="w-full py-3 bg-white text-black hover:bg-gray-100 active:bg-gray-200 rounded-full text-sm font-semibold transition-all cursor-pointer"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
