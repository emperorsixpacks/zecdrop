import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  /** One word group of the title that carries the accent (the gradient). One per page. */
  emphasis?: string;
  /** Kept so older pages compile; no longer drawn (web/DESIGN.md: no eyebrow above a heading). */
  kicker?: string;
  description?: ReactNode;
  /** Right-aligned controls, e.g. a primary button. */
  actions?: ReactNode;
}

/** Title block for a page. It also sets the document title (React 19 hoists
 * <title> into <head>) so a screen reader announces each new page. */
export function PageHeader({ title, emphasis, description, actions }: PageHeaderProps) {
  const at = emphasis === undefined ? -1 : title.indexOf(emphasis);
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <title>{`${title} - ZecDrop`}</title>
      <header className="max-w-[64ch] space-y-2">
        <h1 className="text-[1.75rem] leading-tight font-bold tracking-tight sm:text-[2.75rem] sm:leading-[1.05] sm:tracking-[-0.03em]">
          {at < 0 || emphasis === undefined ? (
            title
          ) : (
            <>
              {title.slice(0, at)}
              <span className="gradient-text">{emphasis}</span>
              {title.slice(at + emphasis.length)}
            </>
          )}
        </h1>
        {description && <p className="text-base text-muted-foreground">{description}</p>}
      </header>
      {actions}
    </div>
  );
}
