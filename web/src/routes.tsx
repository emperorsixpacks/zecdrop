import { Navigate, Route, Routes } from "react-router";

import { PublicLayout } from "@/components/AppShell";
import { NotFoundPage } from "@/components/NotFoundPage";
import AuditPage from "@/features/audit/AuditPage";
import CampaignPage from "@/features/campaign/CampaignPage";
import CampaignsPage from "@/features/campaigns/CampaignsPage";
import HomePage from "@/features/home/HomePage";
import { OperatorArea } from "@/features/operator/OperatorArea";
import PrivacyPage from "@/features/privacy/PrivacyPage";
import ReceiptPage from "@/features/receipt/ReceiptPage";
import { WIZARD_STEPS } from "@/features/wizard/steps";
import WizardLayout from "@/features/wizard/WizardLayout";
import WizardStepPage from "@/features/wizard/WizardStepPage";

const FIRST_STEP = WIZARD_STEPS[0]?.slug ?? "basics";

export function AppRoutes() {
  return (
    <Routes>
      {/* Operator routes: served by the local binary. On a hosted public copy they explain themselves. */}
      <Route element={<OperatorArea />}>
        <Route path="campaigns" element={<CampaignsPage />} />
        <Route path="new" element={<WizardLayout />}>
          <Route index element={<Navigate to={FIRST_STEP} replace />} />
          <Route path=":step" element={<WizardStepPage />} />
        </Route>
        <Route path="campaign/:id" element={<CampaignPage />} />
        <Route path="audit" element={<AuditPage />} />
      </Route>

      {/* Public routes: safe to serve from the key-less hosted verifier. */}
      <Route element={<PublicLayout />}>
        <Route index element={<HomePage />} />
        <Route path="r/:id" element={<ReceiptPage />} />
        <Route path="privacy" element={<PrivacyPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
