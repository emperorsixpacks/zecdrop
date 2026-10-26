import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  /** Small label above the title: where you are. */
  kicker?: string;
  description?: ReactNode;
  /** Right-aligned controls, e.g. a primary button. */
  actions?: ReactNode;
}

/** Title block for a page. It also sets the document title (React 19 hoists
 * <title> into <head>) so a screen reader announces each new page. */
export function PageHeader({
  title,
  kicker,
  description,
  actions,
}: PageHeaderProps) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <title>{`${title} - ZecDrop`}</title>
      <header className="max-w-2xl space-y-1">
        {kicker && (
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {kicker}
          </p>
        )}
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-base text-muted-foreground">{description}</p>
        )}
      </header>
      {actions}
    </div>
  );
}
