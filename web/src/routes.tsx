import { Route, Routes } from "react-router";

import { PublicLayout } from "@/components/AppShell";
import { NotFoundPage } from "@/components/NotFoundPage";
import { ScrollToTop } from "@/components/ScrollToTop";
import AuditPage from "@/features/audit/AuditPage";
import CampaignPage from "@/features/campaign/CampaignPage";
import CampaignsPage from "@/features/campaigns/CampaignsPage";
import GetPaidPage from "@/features/get-paid/GetPaidPage";
import HomePage from "@/features/home/HomePage";
import { OperatorArea } from "@/features/operator/OperatorArea";
import PayslipPage from "@/features/payslip/PayslipPage";
import PrivacyPage from "@/features/privacy/PrivacyPage";
import ReceiptPage from "@/features/receipt/ReceiptPage";
import StartPage from "@/features/start/StartPage";
import CheckStage from "@/features/wizard/CheckStage";
import PayoutFlow from "@/features/wizard/PayoutFlow";
import PayoutsStage from "@/features/wizard/PayoutsStage";
import SendStage from "@/features/wizard/SendStage";

export function AppRoutes() {
  return (
    <>
      <ScrollToTop />
      <Routes>
        {/* Operator routes: served by the local binary. On a hosted public copy they explain themselves. */}
        <Route element={<OperatorArea />}>
          <Route path="campaigns" element={<CampaignsPage />} />
          <Route path="new" element={<PayoutFlow />}>
            <Route index element={<PayoutsStage />} />
            <Route path="check" element={<CheckStage />} />
            <Route path="send" element={<SendStage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
          <Route path="campaign/:id" element={<CampaignPage />} />
          <Route path="audit" element={<AuditPage />} />
        </Route>

        {/* Public routes: safe to serve from the key-less hosted verifier. */}
        <Route element={<PublicLayout />}>
          <Route index element={<HomePage />} />
          <Route path="r/:id" element={<ReceiptPage />} />
          <Route path="get-paid" element={<GetPaidPage />} />
          <Route path="payslip" element={<PayslipPage />} />
          <Route path="privacy" element={<PrivacyPage />} />
          <Route path="start" element={<StartPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </>
  );
}
