"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { Wordmark } from "@/components/brand";
import { CopyReferenceButton } from "@/components/copy-reference-button";
import { PrintButton } from "@/components/print-button";
import { Button } from "@/components/ui/button";
import { SAFETY_DISCLAIMER } from "@/lib/constants";
import { demoTender } from "@/lib/demo/case";
import { getReportDisplayState, loadPersistedReport, resolveReportRun } from "@/lib/reports/persisted-report";
import type { AgentName, AgentRun, OrchestrationRun } from "@/lib/schemas/ofora";
import { cn, formatElapsed } from "@/lib/utils";

type Props = {
  reportId: string;
  initialRun: OrchestrationRun | null;
  demoMode: boolean;
};

export function FairAwardReceiptClient({ reportId, initialRun, demoMode }: Props) {
  const [hydrated, setHydrated] = useState(Boolean(initialRun));
  const [run, setRun] = useState<OrchestrationRun | null>(initialRun);
  const [recoveredFromBrowser, setRecoveredFromBrowser] = useState(false);

  useEffect(() => {
    if (initialRun) {
      setRun(initialRun);
      setRecoveredFromBrowser(false);
      setHydrated(true);
      return;
    }
    const persisted = loadPersistedReport(window.localStorage, reportId);
    const resolved = resolveReportRun({ reportId, serverRun: null, persisted });
    setRun(resolved.run);
    setRecoveredFromBrowser(resolved.recoveredFromBrowser);
    setHydrated(true);
  }, [initialRun, reportId]);

  const realReceiptCount = run?.agents.filter(hasRealReceipt).length ?? 0;
  const displayState = getReportDisplayState({ hydrated, run });

  return (
    <main className="min-h-screen bg-ofora-canvas text-ofora-ink print:bg-white print:text-black">
      <header className="no-print border-b border-ofora-deep/10 bg-white/94 px-4 py-3 backdrop-blur-xl sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <Link href="/workspace" className="text-xl"><Wordmark /></Link>
            <div className="min-w-0 border-l border-ofora-deep/15 pl-4">
              <p className="text-xs font-black uppercase tracking-[0.18em] text-ofora-green">Procurement integrity operations</p>
              <h1 className="truncate text-lg font-black text-ofora-deep sm:text-xl">Fair Award Receipt</h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <TrustBadge tone="mint">Synthetic tender only</TrustBadge>
              {recoveredFromBrowser ? <TrustBadge tone="slate">Recovered from this browser</TrustBadge> : null}
              <EnvironmentBadge demoMode={demoMode} realReceiptCount={realReceiptCount} />
            </div>
            <div className="flex items-center gap-2">
              <Link href="/workspace"><Button variant="secondary" className="border-ofora-border bg-white text-ofora-ink hover:bg-ofora-mist"><ArrowLeft className="h-4 w-4" />Back to workspace</Button></Link>
              <PrintButton />
            </div>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 lg:px-8 print:px-0 print:py-0">
        {displayState === "loading" ? (
          <section className="print-surface rounded-lg border border-ofora-border bg-white p-8 shadow-panel print:border-slate-300 print:bg-white print:shadow-none">
            <h2 className="text-3xl font-black tracking-[-0.04em] text-ofora-deep print:text-black">Loading receipt...</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-ofora-muted print:text-black">Checking this browser for a saved Fair Award Receipt.</p>
          </section>
        ) : displayState === "not_found" ? (
          <section className="print-surface rounded-lg border border-ofora-border bg-white p-8 shadow-panel print:border-slate-300 print:bg-white print:shadow-none">
            <h2 className="text-3xl font-black tracking-[-0.04em] text-ofora-deep print:text-black">Receipt not found</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-ofora-muted print:text-black">No server receipt or browser-saved demo receipt was found. Generate a new synthetic validation run from the workspace.</p>
            <Link href="/workspace" className="mt-6 inline-flex"><Button>Open workspace</Button></Link>
          </section>
        ) : run ? <ReportArticle run={run} demoMode={demoMode} realReceiptCount={realReceiptCount} /> : null}
      </div>
    </main>
  );
}

function ReportArticle({ run, demoMode, realReceiptCount }: { run: OrchestrationRun; demoMode: boolean; realReceiptCount: number }) {
  return (
    <article className="space-y-5 print:space-y-4">
      <ReportSummary run={run} />
      <ReportSection title="Locked policy validation">
        <PolicyCheckRows run={run} />
      </ReportSection>
      <ReportSection title="Normalized supplier submissions">
        <div className="grid gap-3 lg:grid-cols-3">
          {run.outputs?.bidNormalizer?.normalizedSuppliers.map((item) => <SupplierNormalizationCard key={item.supplier} item={item} />)}
        </div>
      </ReportSection>
      <ReportSection title="Supplier risk signals">
        <SupplierRiskRows run={run} />
      </ReportSection>
      <ReportSection title="Award verification findings">
        <AwardFindings run={run} />
      </ReportSection>
      <ReportSection title="Agent outputs and audit boundaries">
        <div className="grid gap-4 md:grid-cols-2">
          <AgentOutputsBlock run={run} />
          <ListBlock title="Audit boundary disclaimer" items={[SAFETY_DISCLAIMER]} />
        </div>
      </ReportSection>
      <ReportSection title={getReceiptTitle(demoMode, realReceiptCount)}>
        <p className="mb-4 text-sm leading-6 text-ofora-muted print:text-black">{getReceiptSubtext(demoMode, realReceiptCount)}</p>
        <ReceiptReferences agents={run.agents} demoMode={demoMode} realReceiptCount={realReceiptCount} />
      </ReportSection>
    </article>
  );
}

function ReportSummary({ run }: { run: OrchestrationRun }) {
  const validationStatus = run.outputs?.awardVerifier?.awardStatus ?? run.status;
  return (
    <section className="print-surface rounded-lg border border-ofora-border bg-white p-5 shadow-panel sm:p-7 print:border-slate-300 print:bg-white print:shadow-none">
      <div className="mb-5 flex flex-wrap items-center gap-2"><TrustBadge tone="mint">Synthetic tender only</TrustBadge><TrustBadge tone="slate">Completed</TrustBadge><TrustBadge tone="mint">Generated from 5 specialist agent outputs</TrustBadge></div>
      <h2 className="text-3xl font-black tracking-[-0.04em] text-ofora-deep sm:text-4xl print:text-black">Fair Award Receipt</h2>
      <AwardOutcomeBlock run={run} />
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><InfoTile label="Receipt reference" value={run.outputs?.receiptWriter?.receiptId ?? run.runId} /><InfoTile label="Tender ID" value={demoTender.tenderId} /><InfoTile label="Selected supplier" value={demoTender.selectedSupplier} /><InfoTile label="Validation status" value={<StatusBadge status={validationStatus} />} /><InfoTile label="Managed value" value={`$${demoTender.managedValueUsd.toLocaleString()}`} /><InfoTile label="Generated output" value="5 specialist agent outputs" /></div>
      <p className="mt-5 rounded-lg border border-ofora-deep/10 bg-ofora-mist p-4 text-sm leading-6 text-ofora-ink print:border-slate-300 print:bg-white print:text-black">{run.outputs?.receiptWriter?.fairAwardReceiptSummary ?? run.outputs?.awardVerifier?.validationSummary ?? "Receipt output pending."}</p>
      <p className="mt-4 text-sm text-ofora-muted print:text-black">{SAFETY_DISCLAIMER}</p>
    </section>
  );
}

function ReportSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="print-surface break-inside-avoid rounded-lg border border-ofora-border bg-white p-5 shadow-[0_12px_36px_rgba(20,35,28,0.05)] print:border-slate-300 print:bg-white print:shadow-none"><div className="mb-4"><h2 className="text-xl font-black text-ofora-deep print:text-black">{title}</h2></div>{children}</section>;
}

function AwardOutcomeBlock({ run }: { run: OrchestrationRun }) {
  const validated = run.outputs?.awardVerifier?.awardStatus === "validated";
  return (
    <div className="mt-5 rounded-lg border border-ofora-verify/25 bg-ofora-mist p-4 print:border-slate-300 print:bg-white">
      <p className="text-[0.7rem] font-black uppercase tracking-[0.16em] text-ofora-green print:text-black">Award validation outcome</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className={cn("rounded-full border px-3 py-1 text-xs font-black print:border-slate-300 print:bg-white print:text-black", validated ? "border-ofora-verify/30 bg-white text-ofora-green" : "border-red-200 bg-red-50 text-red-700")}>{validated ? "AWARD VALIDATED" : "AWARD FLAGGED"}</span>
        <p className="text-lg font-black text-ofora-deep print:text-black">{run.outputs?.receiptWriter?.selectedSupplier ?? demoTender.selectedSupplier} {validated ? "followed" : "requires review against"} the locked evaluation policy.</p>
      </div>
      <p className="mt-2 text-sm leading-6 text-ofora-muted print:text-black">Procurement officer review remains required.</p>
    </div>
  );
}

function InfoTile({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="rounded-lg border border-ofora-border bg-white p-3 print:border-slate-300"><div className="text-xs font-black uppercase tracking-[0.14em] text-ofora-muted print:text-black">{label}</div><div className="mt-1 text-sm leading-6 text-ofora-ink print:text-black">{value}</div></div>;
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  return <div className="rounded-lg border border-ofora-border bg-white p-4 print:border-slate-300"><h3 className="mb-2 text-sm font-black text-ofora-ink print:text-black">{title}</h3><ul className="space-y-2 text-sm leading-6 text-ofora-muted print:text-black">{items.map((item) => <li key={item}>{item}</li>)}</ul></div>;
}

function PolicyCheckRows({ run }: { run: OrchestrationRun }) {
  const checks = run.outputs?.policyLock?.checks ?? [];
  return <div className="overflow-hidden rounded-lg border border-ofora-border print:border-slate-300">{checks.map((item) => { const detail = formatPolicyCheck(item.check, item.summary); return <div key={item.check} className="grid gap-2 border-b border-ofora-border bg-white px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.25fr)_auto] md:items-center print:border-slate-300"><div className="font-black text-ofora-ink print:text-black" title={detail.titleTooltip}>{detail.title}</div><div className="text-sm leading-6 text-ofora-muted print:text-black" title={detail.summaryTooltip}>{detail.summary}</div><StatusBadge status={item.status} /></div>; })}</div>;
}

function SupplierNormalizationCard({ item }: { item: { supplier: string; bidBand: string; deliveryBand: string; documentCompleteness: string; normalizedScore?: number } }) {
  return <div className="break-inside-avoid rounded-lg border border-ofora-border bg-white p-4 print:border-slate-300"><div className="flex items-start justify-between gap-3"><h3 className="font-black text-ofora-ink print:text-black">{item.supplier}</h3><span className="rounded-full border border-ofora-border bg-ofora-soft px-2 py-1 text-xs font-black text-ofora-muted print:border-slate-300 print:bg-white print:text-black">{item.normalizedScore ? `Score ${item.normalizedScore}` : "Score withheld"}</span></div><dl className="mt-3 grid gap-2 text-sm"><CompactDefinition label="Bid band" value={sentenceCase(item.bidBand)} /><CompactDefinition label="Delivery" value={sentenceCase(item.deliveryBand)} /><CompactDefinition label="Documentation" value={sentenceCase(item.documentCompleteness)} /></dl><p className="mt-3 text-xs leading-5 text-ofora-muted print:text-black">Raw commercial proposal fields are withheld.</p></div>;
}

function SupplierRiskRows({ run }: { run: OrchestrationRun }) {
  const flags = run.outputs?.supplierRisk?.riskFlags ?? [];
  return <div className="overflow-hidden rounded-lg border border-ofora-border print:border-slate-300">{flags.map((item) => <div key={`${item.supplier}-${item.issue}`} className="grid gap-2 border-b border-ofora-border bg-white px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,0.8fr)_auto_minmax(0,1.4fr)] md:items-center print:border-slate-300"><div className="font-black text-ofora-ink print:text-black">{item.supplier}</div><RiskBadge severity={item.severity} reviewRequired={item.reviewRequired} selected={item.supplier === demoTender.selectedSupplier} /><div className="text-sm leading-6 text-ofora-muted print:text-black">{item.issue}</div></div>)}</div>;
}

function AwardFindings({ run }: { run: OrchestrationRun }) {
  return <div className="grid gap-4 md:grid-cols-[0.85fr_1.15fr]"><div className="rounded-lg border border-ofora-verify/25 bg-ofora-mist p-4 print:border-slate-300 print:bg-white"><div className="text-xs font-black uppercase tracking-[0.14em] text-ofora-green print:text-black">Decision</div><div className="mt-2"><StatusBadge status={run.outputs?.awardVerifier?.awardStatus ?? "completed"} /></div><p className="mt-3 text-sm leading-6 text-ofora-ink print:text-black">{run.outputs?.awardVerifier?.validationSummary ?? "Award verification output pending."}</p></div><ListBlock title="Review notes" items={run.outputs?.awardVerifier?.reviewNotes ?? []} /></div>;
}

function AgentOutputsBlock({ run }: { run: OrchestrationRun }) {
  const provenance = getAgentProvenance(run);
  return <div className="rounded-lg border border-ofora-border bg-white p-4 print:border-slate-300"><h3 className="mb-3 text-sm font-black text-ofora-ink print:text-black">Agent outputs</h3><div className="space-y-2">{provenance.map((item) => <div key={item.agent} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-ofora-soft px-3 py-2 print:bg-white"><span className="font-black text-ofora-ink print:text-black">{item.agent}</span><span className="font-mono text-xs text-ofora-muted print:text-black">{item.outputRef}</span></div>)}</div></div>;
}

function CompactDefinition({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3 border-t border-ofora-border pt-2 first:border-t-0 first:pt-0 print:border-slate-300"><dt className="text-ofora-muted print:text-black">{label}</dt><dd className="font-semibold text-ofora-ink print:text-black">{value}</dd></div>;
}

function ReceiptReferences({ agents, demoMode, realReceiptCount }: { agents: AgentRun[]; demoMode: boolean; realReceiptCount: number }) {
  const pendingLiveOnly = !demoMode && realReceiptCount === 0;
  return <div className="max-w-full overflow-x-auto rounded-lg border border-ofora-border print:border-slate-300"><table className="w-full min-w-[1080px] text-left text-sm print:min-w-0 print:text-[10px]"><thead className="bg-ofora-mist text-xs uppercase tracking-[0.12em] text-ofora-green print:bg-white print:text-black"><tr><th className="px-3 py-3 print:px-2">Agent</th><th className="px-3 py-3 print:px-2">Mode</th><th className="px-3 py-3 print:px-2">Order</th><th className="px-3 py-3 print:px-2">Receipt</th><th className="px-3 py-3 print:px-2">Delivery</th><th className="px-3 py-3 print:px-2">Elapsed</th></tr></thead><tbody className="divide-y divide-ofora-border bg-white print:divide-slate-300">{agents.map((agent) => { const refs = getAgentRefs(agent, demoMode); const realReceipt = hasRealReceipt(agent); const label = demoMode ? "Simulated reference" : realReceipt ? "Verified CAP" : pendingLiveOnly ? "Pending live receipt" : "Simulated fallback"; return <tr key={agent.name} className="align-top"><td className="px-3 py-3 font-black text-ofora-ink print:px-2 print:text-black">{agent.name}</td><td className="px-3 py-3 print:px-2"><span className={cn("whitespace-nowrap rounded-full border px-2 py-1 text-xs font-black print:border-slate-300 print:bg-white print:text-[10px] print:text-black", demoMode ? "border-amber-200 bg-amber-50 text-amber-800" : realReceipt ? "border-ofora-verify/25 bg-ofora-mist text-ofora-green" : "border-ofora-border bg-ofora-soft text-ofora-muted")}>{label}</span></td><td className="min-w-[190px] px-3 py-3 print:min-w-0 print:px-2"><ReceiptLine value={pendingLiveOnly ? "Pending live receipt" : refs.orderId} /></td><td className="min-w-[200px] px-3 py-3 print:min-w-0 print:px-2"><ReceiptLine value={pendingLiveOnly ? "Pending live receipt" : refs.receiptRef} /></td><td className="min-w-[210px] px-3 py-3 print:min-w-0 print:px-2"><ReceiptLine value={pendingLiveOnly ? "Pending live receipt" : refs.deliveryRef} secondaryValue={pendingLiveOnly ? undefined : refs.providerDeliveryTxHash} /></td><td className="whitespace-nowrap px-3 py-3 font-semibold text-ofora-muted print:px-2 print:text-black">{formatElapsed(agent.elapsedMs)}</td></tr>; })}</tbody></table></div>;
}

function ReceiptLine({ value, secondaryValue }: { value?: string; secondaryValue?: string }) {
  const displayValue = value ?? "Pending live receipt";
  return <div className="min-w-0 space-y-1"><div className="flex min-w-0 items-center gap-1.5"><span className="max-w-[17rem] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs leading-5 text-ofora-ink print:max-w-none print:text-[10px] print:text-black" title={displayValue}>{displayValue}</span>{value && value !== "Pending live receipt" ? <CopyReferenceButton value={value} /> : null}</div>{secondaryValue ? <div className="flex min-w-0 items-center gap-1.5"><span className="max-w-[17rem] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs leading-5 text-ofora-ink print:max-w-none print:text-[10px] print:text-black" title={secondaryValue}>{secondaryValue}</span><CopyReferenceButton value={secondaryValue} /></div> : null}</div>;
}

function StatusBadge({ status }: { status: string }) {
  const label = sentenceCase(status.replaceAll("_", " "));
  const flagged = label === "Flagged";
  return <span className={cn("inline-flex rounded-full border px-2.5 py-1 text-xs font-black print:border-slate-300 print:bg-white print:text-black", flagged ? "border-red-200 bg-red-50 text-red-700" : "border-ofora-verify/25 bg-ofora-mist text-ofora-green")}>{label}</span>;
}

function RiskBadge({ severity, reviewRequired, selected }: { severity: string; reviewRequired: boolean; selected: boolean }) {
  const clear = selected && !reviewRequired;
  const label = clear ? "No material flags" : sentenceCase(severity);
  return <span className={cn("inline-flex w-fit rounded-full border px-2.5 py-1 text-xs font-black print:border-slate-300 print:bg-white print:text-black", clear && "border-ofora-verify/25 bg-ofora-mist text-ofora-green", severity === "medium" && "border-amber-200 bg-amber-50 text-amber-800", severity === "high" && "border-red-200 bg-red-50 text-red-700", severity === "low" && !clear && "border-ofora-border bg-ofora-soft text-ofora-muted")}>{label}</span>;
}

function TrustBadge({ children, tone }: { children: React.ReactNode; tone: "mint" | "amber" | "blue" | "slate" }) {
  return <span className={cn("inline-flex items-center rounded-full border px-3 py-1 text-xs font-black print:border-slate-300 print:bg-white print:text-black", tone === "mint" && "border-ofora-deep/10 bg-ofora-mist text-ofora-green", tone === "amber" && "border-amber-200 bg-amber-50 text-amber-800", tone === "blue" && "border-ofora-verify/25 bg-ofora-mist text-ofora-green", tone === "slate" && "border-ofora-border bg-ofora-soft text-ofora-muted")}>{children}</span>;
}

function EnvironmentBadge({ demoMode, realReceiptCount }: { demoMode: boolean; realReceiptCount: number }) {
  if (demoMode) return <TrustBadge tone="amber">DEMO MODE · Simulated receipts</TrustBadge>;
  if (realReceiptCount === 0) return <TrustBadge tone="blue">LIVE CAP ENABLED · Awaiting first receipt</TrustBadge>;
  if (realReceiptCount < 5) return <TrustBadge tone="amber">MIXED MODE · {realReceiptCount} live receipt(s)</TrustBadge>;
  return <TrustBadge tone="blue">LIVE CAP · Base settlement</TrustBadge>;
}

function getReceiptTitle(demoMode: boolean, realReceiptCount: number) {
  if (demoMode) return "Demo-mode receipts";
  if (realReceiptCount === 0) return "CAP receipts pending";
  if (realReceiptCount < 5) return "Verified CAP receipts + simulated references";
  return "Verified CAP receipts";
}

function getReceiptSubtext(demoMode: boolean, realReceiptCount: number) {
  if (demoMode) return "Simulated CAP lifecycle — no on-chain transaction was submitted.";
  if (realReceiptCount === 0) return "Live CAP mode is enabled, but no verified receipt has been returned yet.";
  if (realReceiptCount < 5) return "Verified CAP receipts are shown only when available; fallback references are clearly labeled.";
  return "CAP delivery receipts and Base settlement references.";
}

function hasRealReceipt(agent: AgentRun) {
  return Boolean(agent.txHash && !agent.txHash.startsWith("demo_") && !agent.txHash.startsWith("demo-") && !agent.txHash.startsWith("sim_") && !agent.txHash.startsWith("pending"));
}

function getAgentRefs(agent: AgentRun, demoMode: boolean) {
  const slug = agent.name.toLowerCase();
  if (demoMode) return { orderId: `demo_order_${slug}_001`, receiptRef: `demo_receipt_${slug}_001`, deliveryRef: `demo_delivery_${slug}_001` };
  return { orderId: isPlaceholderRef(agent.orderId) ? fallbackOrderRef(agent) : agent.orderId, receiptRef: isPlaceholderRef(agent.txHash) ? fallbackReceiptRef(agent) : agent.txHash, deliveryRef: isPlaceholderRef(agent.resultHash) ? fallbackDeliveryRef(agent) : agent.resultHash, providerDeliveryTxHash: isPlaceholderRef(agent.providerDeliveryTxHash) ? undefined : agent.providerDeliveryTxHash };
}

function formatPolicyCheck(check: string, summary: string) {
  if (check === "Criteria weights total 100") {
    return { title: "Criteria weights total 100%", summary: summary.replace("total 100.", "total 100%."), titleTooltip: check, summaryTooltip: summary };
  }
  if (check === "Policy lock timestamp exists") {
    return { title: check, summary: `Policy was locked at ${formatPolicyTimestamp(demoTender.lockedPolicy.lockedAt)}.`, titleTooltip: check, summaryTooltip: summary };
  }
  return { title: check, summary, titleTooltip: check, summaryTooltip: summary };
}

function formatPolicyTimestamp(value: string) {
  const lockedAt = new Date(value);
  if (Number.isNaN(lockedAt.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Africa/Lagos" }).format(lockedAt).replace(" at ", " · ");
}

function getAgentProvenance(run: OrchestrationRun): { agent: AgentName; outputRef: string }[] {
  const existing = new Map((run.outputs?.receiptWriter?.provenance ?? []).map((item) => [item.agent, item.outputRef]));
  return [
    { agent: "PolicyLock", outputRef: existing.get("PolicyLock") ?? "policy-integrity-checks" },
    { agent: "BidNormalizer", outputRef: existing.get("BidNormalizer") ?? "normalized-supplier-bands" },
    { agent: "SupplierRisk", outputRef: existing.get("SupplierRisk") ?? "supplier-risk-flags" },
    { agent: "AwardVerifier", outputRef: existing.get("AwardVerifier") ?? "award-validation-summary" },
    { agent: "ReceiptWriter", outputRef: existing.get("ReceiptWriter") ?? "fair-award-receipt" }
  ];
}

function sentenceCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function isPlaceholderRef(value?: string) {
  return !value || value.startsWith("demo_") || value.startsWith("demo-") || value.startsWith("sim_") || value.startsWith("pending");
}

function fallbackOrderRef(agent: AgentRun) {
  return agent.status === "waiting" ? undefined : `sim_order_${agent.name.toLowerCase()}_pending`;
}

function fallbackReceiptRef(agent: AgentRun) {
  return agent.status === "waiting" ? undefined : `sim_receipt_${agent.name.toLowerCase()}_pending`;
}

function fallbackDeliveryRef(agent: AgentRun) {
  return agent.status === "delivered" ? `sim_delivery_${agent.name.toLowerCase()}_pending` : undefined;
}
