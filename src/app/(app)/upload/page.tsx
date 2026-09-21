import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/session";
import { PageHeader } from "@/components/ui/primitives";
import { UploadWizard } from "./UploadWizard";

export const dynamic = "force-dynamic";

const SAMPLES = [
  {
    name: "meta-ads-14-days.csv",
    description:
      "Meta Ads, 14 days, 4 campaigns with ad sets and ads. Contains a CPA spike, creative fatigue, a zero-conversion campaign and a campaign worth scaling.",
  },
  {
    name: "google-ads-10-days.csv",
    description:
      "Google Ads export with the usual banner rows, “Impr.” headers and a totals row — tests column detection.",
  },
  {
    name: "tiktok-ads-no-dates.csv",
    description:
      "TikTok Ads with no date column and no conversion tracking — shows how AdMate states what it cannot analyse.",
  },
  {
    name: "messy-report-with-issues.csv",
    description:
      "A deliberately broken file: blanks, dashes, a duplicate row, a European decimal comma and more clicks than impressions.",
  },
];

export default async function UploadPage() {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Upload a report"
        description={`Analysing into workspace “${session.workspace.name}”. Your file is parsed, stored against your account only, and never sent to any advertising platform.`}
      />
      <UploadWizard
        workspaceId={session.workspace.id}
        workspaceCurrency={session.workspace.currency}
        samples={SAMPLES}
      />
    </div>
  );
}
