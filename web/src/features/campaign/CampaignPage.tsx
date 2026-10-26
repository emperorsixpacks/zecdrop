import { useParams } from "react-router";

import { CampaignView } from "./CampaignView";

export default function CampaignPage() {
  const { id = "" } = useParams<{ id: string }>();
  return <CampaignView key={id} id={id} />;
}
