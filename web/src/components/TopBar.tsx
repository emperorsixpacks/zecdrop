import { Popover } from "radix-ui";
import { useState } from "react";
import { Link, NavLink, useLocation } from "react-router";

import { SAMPLE_RECEIPT_HREF } from "@/api/demo";
import { AppearanceMenu } from "@/components/AppearanceMenu";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { config, type ZecNetwork } from "@/lib/config";
import { useMediaQuery } from "@/lib/use-media";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  /** Match only this exact path, so "/" is not "current" on every page. */
  end?: boolean;
}

const OPERATOR_LINKS: readonly NavItem[] = [
  { to: "/campaigns", label: "Payouts" },
  { to: "/audit", label: "Audit" },
];

const PUBLIC_LINKS: readonly NavItem[] = [
  { to: "/", label: "Home", end: true },
  { to: SAMPLE_RECEIPT_HREF, label: "Sample receipt" },
  { to: "/payslip", label: "Check a payslip" },
  { to: "/privacy", label: "How privacy works" },
];

interface TopBarProps {
  /** Operator navigation is for the local app. Public pages show a short
   * public menu instead, so a visitor never sees "New payout". */
  showOperatorNav: boolean;
  /** Defaults to the network this page was built for. Operator pages pass the
   * operator's own, which is the one that matters. */
  network?: ZecNetwork;
  /** The operator is on the practice (mock) chain. */
  mock?: boolean;
  /** The operator did not say which chain it is on. */
  modeUnknown?: boolean;
}

const pill = "inline-flex min-h-8 items-center rounded-full border px-3 text-sm font-medium";
const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "relative inline-flex min-h-11 items-center px-2 text-base font-medium sm:px-3",
    "after:absolute after:inset-x-2 after:bottom-1.5 after:h-0.5 after:origin-left after:rounded-full after:bg-primary after:transition-transform after:duration-300 sm:after:inset-x-3",
    isActive ? "text-foreground after:scale-x-100" : "text-muted-foreground after:scale-x-0 hover:text-foreground hover:after:scale-x-100",
  );

/** The public menu on a phone or a tablet: one button, with the links in a panel, so the header is one row.
 * With four links the inline menu needs about 57rem to stay on one row, so it starts at the large breakpoint. */
function PhoneMenu() {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-base font-semibold hover:bg-secondary lg:hidden">
        Menu
        <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(18rem,calc(100vw-1.5rem))] p-2">
        <nav aria-label="Menu">
          <ul>
            {PUBLIC_LINKS.map((link) => (
              <li key={link.to}>
                <NavLink
                  to={link.to}
                  end={link.end ?? false}
                  onClick={() => {
                    setOpen(false);
                  }}
                  className={({ isActive }) =>
                    cn("flex min-h-11 items-center rounded-lg px-3 text-base font-semibold hover:bg-secondary", isActive && "bg-secondary")
                  }
                >
                  {link.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </PopoverContent>
    </Popover.Root>
  );
}

export function TopBar({ showOperatorNav, network = config.network, mock = false, modeUnknown = false }: TopBarProps) {
  const { pathname } = useLocation();
  // One highlighted button per screen. Starting a payout is the point of the payouts page, so
  // there it is highlighted; elsewhere it is a quiet outline, and while paying it is not shown.
  const wide = useMediaQuery("(min-width: 40rem)");
  const paying = pathname === "/new" || pathname.startsWith("/new/");
  const startIsPrimary = pathname === "/campaigns";
  const newPayout = showOperatorNav && !paying && (
    <Button asChild variant={startIsPrimary ? "default" : "outline"}>
      <Link to="/new">New payout</Link>
    </Button>
  );
  // Quiet on testnet, which is the default; loud on mainnet, where the coins are real.
  const networkLabel =
    network === "mainnet" ? (
      <span className={cn(pill, "border-foreground bg-foreground text-background")}>Zcash mainnet</span>
    ) : (
      <span className="inline-flex min-h-8 items-center px-2 text-sm text-muted-foreground">Zcash testnet</span>
    );

  return (
    <header className="border-b border-border">
      <div className="mx-auto flex w-full max-w-[68rem] flex-wrap items-center gap-x-4 gap-y-0 px-5 py-2 sm:gap-x-6">
        <Link
          to={showOperatorNav ? "/campaigns" : "/"}
          className="inline-flex min-h-11 items-center gap-2 text-xl font-bold tracking-[-0.03em]"
        >
          <span aria-hidden className="h-3 w-5 rounded-[2px] bg-bar" />
          ZecDrop
        </Link>

        {showOperatorNav ? (
          <nav aria-label="Primary">
            <ul className="flex gap-x-0 sm:gap-x-1">
              {OPERATOR_LINKS.map((link) => (
                <li key={link.to}>
                  <NavLink to={link.to} className={linkClass}>
                    {link.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        ) : (
          <>
            <PhoneMenu />
            <nav aria-label="Primary" className="hidden lg:block">
              <ul className="flex gap-x-1">
                {PUBLIC_LINKS.map((link) => (
                  <li key={link.to}>
                    <NavLink to={link.to} end={link.end ?? false} className={linkClass}>
                      {link.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
          </>
        )}

        {/* The settings, and on a wide screen the one button, stay on the first line. */}
        <div className="ml-auto flex items-center gap-1">
          {showOperatorNav ? (
            wide && <span className="mr-2">{newPayout}</span>
          ) : (
            <span className="mr-1 hidden sm:inline-flex">{networkLabel}</span>
          )}
          {/* On a phone the operator's header has room for one icon; the mode is in the appearance panel. */}
          <span className={showOperatorNav ? "hidden sm:block" : undefined}>
            <ThemeToggle />
          </span>
          <AppearanceMenu />
        </div>

        {/* The state of the chain: a quiet line of its own under the first one. On a phone the one button waits at its end. */}
        {showOperatorNav ? (
          <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 pb-1">
            {mock && (
              <span role="status" className={cn(pill, "hatched min-h-7 border-foreground/50 text-xs sm:text-sm")}>
                Practice mode: nothing is sent to Zcash
              </span>
            )}
            {modeUnknown && (
              <span role="status" className={cn(pill, "border-foreground/50")}>
                Chain mode unknown: practice controls hidden
              </span>
            )}
            {/* In practice mode the pill already says it; on a phone the network label gives its line back. */}
            <span className={mock ? "hidden sm:inline-flex" : "inline-flex"}>{networkLabel}</span>
            {!wide && <span className="ml-auto">{newPayout}</span>}
          </div>
        ) : (
          network === "mainnet" && <span className="sm:hidden">{networkLabel}</span>
        )}
      </div>
    </header>
  );
}
