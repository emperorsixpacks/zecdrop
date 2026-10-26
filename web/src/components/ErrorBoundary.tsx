import { Component, type ErrorInfo, type ReactNode } from "react";

/** The last thing between a bug and a blank page. If anything below throws while drawing, the
 * person sees a sentence and a way out instead of nothing. It says nothing about what went wrong:
 * the message of an error could, in principle, carry something from the page, so it is neither
 * shown nor logged here. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Deliberately empty: see the comment above.
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="mx-auto max-w-[60rem] space-y-4 px-5 py-16">
        <h1 className="text-[1.75rem] leading-tight font-bold tracking-[-0.02em] sm:text-[2.75rem]">Something went wrong</h1>
        <p className="max-w-[64ch] text-base">The page stopped drawing. Reload it to carry on; anything you had not sent is gone, and nothing was stored.</p>
        <button
          type="button"
          className="inline-flex h-11 items-center rounded-lg border border-foreground px-5 text-base font-semibold hover:bg-foreground hover:text-background"
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload the page
        </button>
      </main>
    );
  }
}
