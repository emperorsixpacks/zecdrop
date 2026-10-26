import type { ReactNode } from "react";
import { Outlet } from "react-router";

import { Footer } from "@/components/Footer";
import { TopBar } from "@/components/TopBar";
import type { ZecNetwork } from "@/lib/config";

interface ShellProps {
  showOperatorNav: boolean;
  /** The network to show. Defaults to the page's configured one. */
  network?: ZecNetwork;
  /** True when the operator runs on the mock chain. */
  mock?: boolean;
  /** A strip between the header and the content, e.g. the mock-chain banner. */
  banner?: ReactNode;
  children: ReactNode;
}

/** Page chrome shared by every route: skip link, top bar, main, footer. */
export function Shell({ showOperatorNav, network, mock, banner, children }: ShellProps) {
  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <TopBar
        showOperatorNav={showOperatorNav}
        {...(network ? { network } : {})}
        {...(mock ? { mock } : {})}
      />
      {banner}
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-5xl flex-1 px-5 py-10 outline-none"
      >
        {children}
      </main>
      <Footer />
    </div>
  );
}

/** Routes that are safe to serve publicly (receipt, privacy, not found). */
export function PublicLayout() {
  return (
    <Shell showOperatorNav={false}>
      <Outlet />
    </Shell>
  );
}
