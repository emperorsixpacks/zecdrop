import { Link, NavLink } from "react-router";

import { SAMPLE_RECEIPT_HREF } from "@/api/demo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Badge } from "@/components/ui/badge";
import { config, type ZecNetwork } from "@/lib/config";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
}

const OPERATOR_LINKS: readonly NavItem[] = [
  { to: "/campaigns", label: "Campaigns" },
  { to: "/new", label: "New campaign" },
  { to: "/audit", label: "Audit" },
];

const PUBLIC_LINKS: readonly NavItem[] = [
  { to: SAMPLE_RECEIPT_HREF, label: "Sample receipt" },
  { to: "/privacy", label: "Privacy boundary" },
];

interface TopBarProps {
  /** Operator navigation is for the local app. Public pages show a short
   * public menu instead, so a visitor never sees "New campaign". */
  showOperatorNav: boolean;
  /** Defaults to the network this page was built for. Operator pages pass the
   * operator's own, which is the one that matters. */
  network?: ZecNetwork;
  mock?: boolean;
}

export function TopBar({ showOperatorNav, network = config.network, mock = false }: TopBarProps) {
  return (
    <header className="border-b">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-8 gap-y-3 px-5 py-3">
        <Link
          to="/"
          className="flex items-center gap-2 text-base font-semibold tracking-tight"
        >
          <span aria-hidden className="size-3 rounded-full bg-primary" />
          ZecDrop
        </Link>

        <nav aria-label="Primary">
          <ul className="flex flex-wrap gap-1">
            {(showOperatorNav ? OPERATOR_LINKS : PUBLIC_LINKS).map((link) => (
              <li key={link.to}>
                <NavLink
                  to={link.to}
                  className={({ isActive }) =>
                    cn(
                      "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )
                  }
                >
                  {link.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {mock && <Badge variant="shielded">Mock chain</Badge>}
          <Badge variant={network === "mainnet" ? "default" : "outline"}>Zcash {network}</Badge>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
