import { Link } from "react-router";

export function Footer() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2 px-5 py-5 text-sm text-muted-foreground">
        <p>Private amounts, public accountability.</p>
        <Link
          to="/privacy"
          className="font-medium text-link underline underline-offset-4"
        >
          Privacy boundary
        </Link>
      </div>
    </footer>
  );
}
