import { Link } from "react-router";

import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";

export function NotFoundPage() {
  return (
    <>
      <PageHeader
        title="Page not found"
        description="There is nothing at this address."
      />
      <Button asChild variant="outline">
        <Link to="/">Go to the start page</Link>
      </Button>
    </>
  );
}
