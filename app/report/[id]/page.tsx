import { FairAwardReceiptClient } from "@/components/report/fair-award-receipt-client";
import { getRun } from "@/lib/agents/orchestrator";
import { isDemoMode } from "@/lib/utils";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function ReportPage({ params }: Props) {
  const { id } = await params;
  return <FairAwardReceiptClient reportId={id} initialRun={getRun(id) ?? null} demoMode={isDemoMode()} />;
}
