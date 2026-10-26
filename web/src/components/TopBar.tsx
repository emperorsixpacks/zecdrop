import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Link, NavLink, useLocation } from "react-router";

import { SAMPLE_RECEIPT_HREF } from "@/api/demo";
import { AppearanceMenu } from "@/components/AppearanceMenu";
import { ThemeToggle } from "@/components/ThemeToggle";
import { config, type ZecNetwork } from "@/lib/config";
import { pageName } from "@/lib/page-name";
import { usePractice } from "@/lib/practice-mode";
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
  { to: "/get-paid", label: "Get paid" },
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

/** How long the morph's transitions stay on after the capsule is opened or closed: a little longer than the longest of
 * them (the width, 350 ms when Lively; the last row of the panel has faded in by about 390 ms). Outside that window nothing
 * about the capsule is animated, so a page name that changes its width does not tween, and nothing moves on load. */
const MORPH_MS = 450;

type NetworkKind = "practice" | "mainnet" | "testnet";

const chip = "inline-flex h-7 shrink-0 items-center rounded-full border px-2.5 text-sm font-semibold";

/** The network, in a word, on the capsule itself, so it is seen without opening anything. In practice mode there is no
 * network to name: the chip says what this is. Otherwise quiet on testnet, which is the default, and loud on mainnet,
 * where the coins are real. */
function NetworkChip({ kind }: { kind: NetworkKind }) {
  if (kind === "practice") {
    return (
      <span data-network="practice" className={cn(chip, "island-chip hatched border-island-ink/55 text-island-ink")}>
        Practice
      </span>
    );
  }
  if (kind === "mainnet") {
    return (
      <span data-network="mainnet" className={cn(chip, "island-chip border-island-ink/50 bg-marker text-marker-ink")}>
        Mainnet
      </span>
    );
  }
  return (
    <span data-network="testnet" className="shrink-0 px-1 text-sm text-island-muted">
      testnet
    </span>
  );
}

/** The same, in full, in the open panel. */
function NetworkLabel({ kind }: { kind: NetworkKind }) {
  if (kind === "practice") {
    return <span className={cn(chip, "island-chip hatched border-island-ink/55 font-medium text-island-ink")}>Practice, nothing is real</span>;
  }
  if (kind === "mainnet") {
    return <span className={cn(chip, "island-chip border-island-ink/50 bg-marker text-marker-ink")}>Zcash mainnet</span>;
  }
  return <span className="text-sm text-island-muted">Zcash testnet</span>;
}

/** Whether an event's target is part of the capsule: inside it, or in the appearance panel it opened (that panel is
 * drawn at the end of the page, outside the capsule's own element, but it belongs to it). */
function isInside(root: HTMLElement | null, target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (root?.contains(target) ?? false) || target.closest('[data-slot="popover-content"]') !== null;
}

/** The header: one capsule at the top centre of the page, the site's own redaction bar. Collapsed it is a single button
 * holding the mark, the name of the page and the network; opened it morphs into a panel with the links and the
 * settings. The reasons for each choice are in web/DESIGN.md. */
export function TopBar({ showOperatorNav, network = config.network, mock = false, modeUnknown = false }: TopBarProps) {
  const location = useLocation();
  const { pathname } = location;
  const practice = usePractice((state) => state.on);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // Open or closed, and whether the morph's transitions are on (see MORPH_MS). One state, so both change in one render.
  const [island, setIsland] = useState({ open: false, morph: false });
  const { open, morph } = island;

  // A new page closes the capsule, however the visitor got there: a link in it, the back button, a link in the page.
  const [seenPage, setSeenPage] = useState(location.key);
  if (seenPage !== location.key) {
    setSeenPage(location.key);
    if (open) setIsland({ open: false, morph: true });
  }

  useEffect(() => {
    if (!island.morph) return;
    const timer = window.setTimeout(() => {
      setIsland((now) => ({ ...now, morph: false }));
    }, MORPH_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [island]);

  // The capsule is as wide as its one row, in pixels, so that opening it has a width to grow from (a width of
  // "fit-content" cannot be animated). It is kept up to date as the name of the page, the font or the screen changes.
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = row.current;
    if (element === null || typeof ResizeObserver !== "function") return;
    // Told once when it starts to watch, before the first paint, and again whenever the row changes size.
    const observer = new ResizeObserver(() => {
      setRowWidth(Math.ceil(element.getBoundingClientRect().width));
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const closeToTheButton = () => {
    setIsland({ open: false, morph: true });
    button.current?.focus({ preventScroll: true });
  };

  // While it is open: Escape closes it and gives the focus back to the capsule; a press anywhere else on the page closes it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // The appearance panel takes Escape for itself (and says so by cancelling it): that closes the panel, not this.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setIsland({ open: false, morph: true });
      button.current?.focus({ preventScroll: true });
    };
    const onPointerDown = (event: PointerEvent) => {
      if (isInside(root.current, event.target)) return;
      setIsland({ open: false, morph: true });
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  const kind: NetworkKind = practice ? "practice" : network === "mainnet" ? "mainnet" : "testnet";
  const links = showOperatorNav ? OPERATOR_LINKS : PUBLIC_LINKS;
  const name = pageName(pathname, showOperatorNav);
  // The name of the site is the page's name on a page that has none of its own: say it once.
  const showBrand = name !== "ZecDrop";

  // One highlighted button per screen. Starting a payout is the point of the payouts page, so
  // there it is highlighted; elsewhere it is a quiet outline, and while paying it is not shown.
  const paying = pathname === "/new" || pathname.startsWith("/new/");
  const startIsPrimary = pathname === "/campaigns";
  const newPayout = showOperatorNav && !paying && (
    <Link
      to="/new"
      data-slot="island-action"
      className={cn(
        "island-action relative mr-1 inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 rounded-full border text-sm font-semibold",
        "after:absolute after:-inset-1 sm:px-3.5",
        startIsPrimary ? "border-transparent bg-island-ink text-island" : "border-island-ink/55 text-island-ink hover:bg-island-ink/14",
      )}
    >
      <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
      <span className="max-sm:sr-only">New payout</span>
    </Link>
  );

  return (
    <>
      <header className="island-header print:hidden">
        <div
          ref={root}
          className="island"
          data-open={open}
          data-morph={morph}
          style={rowWidth === null ? undefined : ({ "--island-w": `${String(rowWidth)}px` } as CSSProperties)}
          onBlur={(event) => {
            // Focus moving to something outside the capsule closes it. Focus moving to nothing (a click on bare page,
            // another window) does not: the press itself says what to do.
            if (open && event.relatedTarget !== null && !isInside(root.current, event.relatedTarget)) {
              setIsland({ open: false, morph: true });
            }
          }}
        >
          <div ref={row} className="island-row">
            <button
              ref={button}
              type="button"
              data-slot="island"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => {
                setIsland((now) => ({ open: !now.open, morph: true }));
              }}
              className="flex h-11 min-w-0 cursor-pointer items-center gap-2 rounded-[1.375rem] pr-3 pl-3.5 whitespace-nowrap text-island-ink hover:bg-island-ink/14"
            >
              {/* The spaces between the parts are not drawn (they are flex items) but they are in the button's name: "ZecDrop Home testnet". */}
              <span aria-hidden className="island-mark h-3 w-5 shrink-0 rounded-[2px] bg-island-ink" />
              {showBrand && (
                <>
                  {/* On the narrowest screens the word gives way first; it stays in the button's name. */}
                  <span className="text-base font-bold tracking-[-0.03em] max-[24rem]:sr-only">ZecDrop</span>{" "}
                  <span aria-hidden className="island-divider mx-1 h-4 w-px shrink-0 bg-island-ink/40 max-[24rem]:hidden" />
                </>
              )}
              <span className="island-name truncate text-sm font-semibold">{name}</span>{" "}
              <svg aria-hidden viewBox="0 0 24 24" className="island-chevron -ml-1 size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="m6 9 6 6 6-6" />
              </svg>
              <NetworkChip kind={kind} />
            </button>
            {newPayout}
          </div>

          {/* Not in the tab order, nor read out, while the capsule is closed; and not drawn once the morph is done. */}
          <div id={panelId} data-slot="island-panel" className="island-panel" inert={!open}>
            <div className="island-panel-inner">
              <nav aria-label="Primary">
                <ul>
                  {links.map((link, index) => (
                    <li key={link.to} className="island-item" style={{ "--i": index } as CSSProperties}>
                      <NavLink
                        to={link.to}
                        end={link.end ?? false}
                        onClick={closeToTheButton}
                        className="island-link flex min-h-11 items-center rounded-2xl px-3 text-base font-semibold text-island-ink hover:bg-island-ink/14"
                      >
                        {({ isActive }) => (
                          <span
                            className={cn(
                              "island-label -mx-1.5 rounded-[4px] px-1.5 py-0.5",
                              // The highlighter marks where you are; the heavier type says it too, for whoever cannot tell the colours apart.
                              isActive && "bg-marker font-extrabold text-marker-ink",
                            )}
                          >
                            {link.label}
                          </span>
                        )}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </nav>
              <div className="island-item island-footer mt-1 flex items-center justify-between gap-3 border-t border-island-ink/25 pt-1 pl-3" style={{ "--i": links.length } as CSSProperties}>
                <NetworkLabel kind={kind} />
                <div className="flex items-center gap-1">
                  <ThemeToggle />
                  {/* Keyed by the capsule's state, so that closing the capsule takes its appearance panel with it (a new page, the
                   * back button), rather than leaving it open on a page with no way to its button. */}
                  <AppearanceMenu key={open ? "open" : "closed"} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* The state of the chain: a quiet line of its own, directly under the capsule. */}
      {showOperatorNav && ((mock && !practice) || modeUnknown) && (
        <div className="mx-auto flex w-full max-w-[68rem] flex-wrap items-center justify-center gap-x-3 gap-y-1 px-5 pt-2">
          {mock && !practice && (
            <span role="status" className="hatched inline-flex min-h-7 items-center rounded-full border border-foreground/50 px-3 text-xs font-medium sm:text-sm">
              Practice mode: nothing is sent to Zcash
            </span>
          )}
          {modeUnknown && (
            <span role="status" className="inline-flex min-h-8 items-center rounded-full border border-foreground/50 px-3 text-sm font-medium">
              Chain mode unknown: practice controls hidden
            </span>
          )}
        </div>
      )}
    </>
  );
}
