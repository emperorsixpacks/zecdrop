import { Link } from "react-router";

const link = "inline-flex min-h-11 items-center font-medium text-foreground underline underline-offset-4";

export function Footer({ showOperatorLink = false }: { showOperatorLink?: boolean }) {
  return (
    <footer className="mt-16 border-t border-border">
      <div className="mx-auto flex w-full max-w-[68rem] flex-wrap items-center justify-between gap-x-6 gap-y-1 px-5 py-6 text-sm text-muted-foreground">
        <p>Private amounts, public accountability.</p>
        <p className="flex flex-wrap gap-x-6">
          {showOperatorLink && (
            <Link to="/campaigns" className={link}>
              Running a payout? Open the operator app
            </Link>
          )}
          <Link to="/privacy" className={link}>
            How privacy works
          </Link>
        </p>
      </div>
    </footer>
  );
}
