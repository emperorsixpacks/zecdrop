import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { unstable_HistoryRouter as HistoryRouter } from "react-router";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ViewTransitionGate } from "@/components/ViewTransitionGate";
import { createTransitionHistory } from "@/lib/view-transition";
import { AppRoutes } from "@/routes";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

export default function App() {
  // The browser's own history, whose `push` is a view transition where the browser has them (src/lib/view-transition.ts).
  const [history] = useState(createTransitionHistory);
  return (
    <QueryClientProvider client={queryClient}>
      <HistoryRouter history={history}>
        <ViewTransitionGate />
        <ErrorBoundary>
          <AppRoutes />
        </ErrorBoundary>
      </HistoryRouter>
    </QueryClientProvider>
  );
}
