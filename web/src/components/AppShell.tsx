import type { ReactNode } from "react";
import { Outlet, useLocation, useMatch } from "react-router";

import { demoCase } from "@/api/demo";
import { parseReceiptLink } from "@/api/receipt-query";
import { Footer } from "@/components/Footer";
import { Toaster } from "@/components/Toaster";
import { TopBar } from "@/components/TopBar";
import type { ZecNetwork } from "@/lib/config";

interface ShellProps {
  showOperatorNav: boolean;
  /** The network to show. Defaults to the page's configured one. */
  network?: ZecNetwork;
  /** True when the operator runs on the practice (mock) chain. */
  mock?: boolean;
  /** True when the operator did not say which chain it is on. */
  modeUnknown?: boolean;
  children: ReactNode;
}

/** Page chrome shared by every route: skip link, header, main, footer. */
export function Shell({ showOperatorNav, network, mock, modeUnknown, children }: ShellProps) {
  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-3 focus:text-base focus:font-semibold focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <TopBar
        showOperatorNav={showOperatorNav}
        {...(network ? { network } : {})}
        {...(mock ? { mock } : {})}
        {...(modeUnknown ? { modeUnknown } : {})}
      />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[68rem] flex-1 px-5 pt-8 pb-10 outline-none sm:pt-12">
        {children}
      </main>
      <Footer showOperatorLink={!showOperatorNav} />
      <Toaster />
    </div>
  );
}

/** The network a receipt page's own address names, so the header says what the page is about.
 * Nothing on any other page, on a sample (it asks no verifier) or on a link the page cannot
 * read: those keep the build's network, as the receipt page itself does. */
function useReceiptLinkNetwork(): ZecNetwork | undefined {
  const route = useMatch("/r/:id");
  const { search } = useLocation();
  if (route === null) return undefined;
  const params = new URLSearchParams(search);
  if (demoCase(route.params.id, params) !== null) return undefined;
  const link = parseReceiptLink(params);
  return link.ok ? link.query.network : undefined;
}

/** Routes that are safe to serve publicly (receipt, privacy, not found). A mainnet receipt is
 * headed "Zcash mainnet" whatever network the page was built for. */
export function PublicLayout() {
  const network = useReceiptLinkNetwork();
  return (
    <Shell showOperatorNav={false} {...(network ? { network } : {})}>
      <Outlet />
    </Shell>
  );
}
