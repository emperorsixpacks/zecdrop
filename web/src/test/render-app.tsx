// Render the whole app (routes, layouts, providers) at a URL, optionally with
// an operator session. Used by the page tests; they pair it with
// installFakeOperator so no real network is touched.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { adoptTokenFromText, clearSession } from "@/api/operator/session";
import { AppRoutes } from "@/routes";

export const TEST_TOKEN = "ab".repeat(32);

/** Give the page a valid operator token, the way pasting the link would. */
export function signIn(): void {
  clearSession();
  adoptTokenFromText(TEST_TOKEN);
}

export function renderApp(path: string, options: { signedIn?: boolean } = {}) {
  if (options.signedIn) signIn();
  else clearSession();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}
