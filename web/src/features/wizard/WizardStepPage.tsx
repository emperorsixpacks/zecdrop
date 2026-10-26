import type { ReactElement } from "react";
import { useParams } from "react-router";

import { NotFoundPage } from "@/components/NotFoundPage";

import AuditorStep from "./AuditorStep";
import BasicsStep from "./BasicsStep";
import FundStep from "./FundStep";
import RecipientsStep from "./RecipientsStep";
import ReviewStep from "./ReviewStep";

/** The step for a URL slug. A switch, not an object lookup: the slug comes from the URL. */
function stepFor(slug: string | undefined): ReactElement | null {
  switch (slug) {
    case "basics":
      return <BasicsStep />;
    case "recipients":
      return <RecipientsStep />;
    case "auditor":
      return <AuditorStep />;
    case "review":
      return <ReviewStep />;
    case "fund":
      return <FundStep />;
    default:
      return null;
  }
}

export default function WizardStepPage() {
  const { step: slug } = useParams<{ step: string }>();
  return stepFor(slug) ?? <NotFoundPage />;
}
