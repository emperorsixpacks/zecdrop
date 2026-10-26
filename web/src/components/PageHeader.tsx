import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  /** Kept so older pages compile; no longer drawn (web/DESIGN.md: no eyebrow above a heading). */
  kicker?: string;
  description?: ReactNode;
  /** Right-aligned controls, e.g. a primary button. */
  actions?: ReactNode;
}

/** Title block for a page. It also sets the document title (React 19 hoists
 * <title> into <head>) so a screen reader announces each new page. */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <title>{`${title} - ZecDrop`}</title>
      <header className="max-w-[64ch] space-y-2">
        <h1 className="display text-[2rem] leading-[1.05] text-balance sm:text-[3rem]">{title}</h1>
        {description && <p className="text-base text-muted-foreground">{description}</p>}
      </header>
      {actions}
    </div>
  );
}
