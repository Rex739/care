"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type Dispatch, type ElementType, type ReactNode, type SetStateAction } from "react";
import {
  Activity,
  ArrowRight,
  Check,
  ClipboardList,
  Copy,
  LayoutDashboard,
  Loader2,
  Menu,
  ReceiptText,
  Search,
  Settings,
  ShieldCheck,
  Users,
  X
} from "lucide-react";
import { Wordmark } from "@/components/brand";
import { OforaBrand } from "@/components/brand/ofora-brand";
import { Button } from "@/components/ui/button";
import { AGENT_PRICE_CENTS, AGENT_PRICES, formatUsdcCents, ORCHESTRATION_MARGIN, SAFETY_DISCLAIMER, SPECIALIST_SPEND, SYNTHETIC_CASE_NOTICE, USER_PRICE } from "@/lib/constants";
import { clearPersistedReports, loadLatestPersistedReport, PERSISTED_REPORT_STORAGE_PREFIX, savePersistedReport } from "@/lib/reports/persisted-report";
import type { AgentName, AgentRun, OrchestrationRun, TenderPacketInput } from "@/lib/schemas/ofora";
import { cn, formatElapsed, shortId } from "@/lib/utils";
import {
  createSafeRecoveredRunState,
  DEFAULT_RECOVERABLE_POLICY_LOCK_ORDER_ID,
  parseSafeRecoveredRunState,
  SAFE_RECOVERED_RUN_STORAGE_KEY,
  serializeSafeRecoveredRunState
} from "@/lib/workspace/recovered-run-state";

type WorkspaceView = "Overview" | "Validation Runs" | "Tender Packet" | "Suppliers" | "Receipts" | "Audit Boundaries" | "Settings";
type ReliableRunStatus = "idle" | "running" | "completed" | "failed";

type EnvStatus = {
  demoMode: boolean;
  liveSpecialistsConfigured: boolean;
  policyLockLiveEnabled: boolean;
  bidNormalizerLiveEnabled: boolean;
  supplierRiskLiveEnabled: boolean;
  liveAgentNames: AgentName[];
  crooConfigured: boolean;
  coordinatorKeyConfigured: boolean;
  policyServiceConfigured: boolean;
  bidNormalizerKeyConfigured: boolean;
  bidNormalizerServiceConfigured: boolean;
  supplierRiskKeyConfigured: boolean;
  supplierRiskServiceConfigured: boolean;
  liveFallbackEnabled: boolean;
  openaiConfigured: boolean;
};

type Props = {
  tenderPacket: TenderPacketInput;
  demoMode: boolean;
  envStatus: EnvStatus;
};

const agentNames: AgentName[] = ["PolicyLock", "BidNormalizer", "SupplierRisk", "AwardVerifier", "ReceiptWriter"];
const statusTimeline: AgentRun["status"][] = ["waiting", "negotiating", "payment_pending", "paid", "processing", "delivered"];

const sidebarItems: { label: WorkspaceView; icon: ElementType }[] = [
  { label: "Overview", icon: LayoutDashboard },
  { label: "Validation Runs", icon: Activity },
  { label: "Tender Packet", icon: ClipboardList },
  { label: "Suppliers", icon: Users },
  { label: "Receipts", icon: ReceiptText },
  { label: "Audit Boundaries", icon: ShieldCheck },
  { label: "Settings", icon: Settings }
];

const activityEvents = [
  "Tender packet initialized",
  "PolicyLock delivered",
  "BidNormalizer delivered",
  "SupplierRisk delivered",
  "AwardVerifier completed",
  "Fair Award Receipt created"
];

export function WorkspaceClient({ tenderPacket, demoMode, envStatus }: Props) {
  const [activeView, setActiveView] = useState<WorkspaceView>("Overview");
  const [run, setRun] = useState<OrchestrationRun | null>(null);
  const [agents, setAgents] = useState<AgentRun[]>(initialAgents);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedReceiptCount, setSavedReceiptCount] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const animationTimers = useRef<number[]>([]);

  const selectedSupplier = tenderPacket.suppliers.find((supplier) => supplier.name === tenderPacket.selectedSupplier);
  const riskCount = useMemo(
    () =>
      tenderPacket.suppliers.reduce(
        (count, supplier) =>
          count + (supplier.documents.length < 4 ? 1 : 0) + (supplier.declaredConflicts ? 1 : 0) + (supplier.deliveryDays > 21 ? 1 : 0),
        0
      ),
    [tenderPacket]
  );
  const runStatus = getReliableRunStatus({ loading, error, run });
  const displayAgents = useMemo(() => getDisplayAgents(agents, runStatus, run), [agents, runStatus, run]);
  const deliveredCount = runStatus === "idle" ? 0 : displayAgents.filter((agent) => agent.status === "delivered").length;
  const realReceiptCount = displayAgents.filter(hasRealReceipt).length;
  const hasSimulatedFallback = !demoMode && realReceiptCount > 0 && realReceiptCount < agentNames.length;
  const livePreflightIssue = getLivePreflightIssue(envStatus);
  const recoverablePaidOrder = hasRecoverablePaidOrder(displayAgents);

  useEffect(() => {
    const timers = animationTimers.current;
    return () => clearAnimationTimers(timers);
  }, []);

  useEffect(() => {
    setSavedReceiptCount(countSavedDemoReceipts());
  }, []);

  useEffect(() => {
    if (run || loading) return;
    if (envStatus.policyLockLiveEnabled) {
      const recoveredState = parseSafeRecoveredRunState(window.localStorage.getItem(SAFE_RECOVERED_RUN_STORAGE_KEY));
      if (recoveredState) {
        setRun(recoveredState.run);
        setAgents(recoveredState.run.agents);
        setError(null);
        return;
      }
    }
    const persistedReport = loadLatestPersistedReport(window.localStorage);
    if (!persistedReport) return;
    setRun(persistedReport.run);
    setAgents(persistedReport.run.agents);
    setError(null);
  }, [envStatus.policyLockLiveEnabled, loading, run]);

  useEffect(() => {
    const recoveredState = createSafeRecoveredRunState(run);
    if (!recoveredState) return;
    window.localStorage.setItem(SAFE_RECOVERED_RUN_STORAGE_KEY, serializeSafeRecoveredRunState(recoveredState));
  }, [run]);

  useEffect(() => {
    if (!run || run.status !== "completed" || !hasValidReceipt(run)) return;
    const saved = savePersistedReport(window.localStorage, run, tenderPacket);
    if (saved) setSavedReceiptCount(countSavedDemoReceipts());
  }, [run, tenderPacket]);

  async function startRun() {
    if (livePreflightIssue) {
      setError(livePreflightIssue);
      return;
    }
    if (runStatus === "failed" && recoverablePaidOrder) {
      setError("A paid order has unresolved delivery metadata. Recover delivery before starting another paid validation.");
      return;
    }
    clearAnimationTimers(animationTimers.current);
    window.localStorage.removeItem(SAFE_RECOVERED_RUN_STORAGE_KEY);
    setLoading(true);
    setError(null);
    setRun(null);
    animateAgents(setAgents, demoMode, animationTimers.current);
    const response = await fetch("/api/orchestrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tenderPacket)
    });
    const payload = (await response.json()) as { run?: OrchestrationRun; error?: string };
    setLoading(false);
    clearAnimationTimers(animationTimers.current);
    if (!response.ok || !payload.run) {
      setError(payload.error ?? "The Ofora Coordinator could not complete validation.");
      setAgents(markFailedAgents);
      return;
    }
    setAgents(payload.run.agents);
    setRun(payload.run);
  }

  async function recoverCompletedOrder(orderId = getRecoverableOrderId(displayAgents)) {
    if (!orderId) return;
    setLoading(true);
    setError(null);
    const response = await fetch("/api/recover-policy-lock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId })
    });
    const payload = (await response.json()) as { run?: OrchestrationRun; error?: string };
    setLoading(false);
    if (!response.ok || !payload.run) {
      setError(payload.error ?? "PolicyLock delivery recovery failed.");
      return;
    }
    setRun(payload.run);
    setAgents(payload.run.agents);
  }

  function clearRecoveredRun() {
    window.localStorage.removeItem(SAFE_RECOVERED_RUN_STORAGE_KEY);
    setRun(null);
    setAgents(initialAgents);
    setError(null);
    setLoading(false);
  }

  function clearSavedDemoReceipts() {
    const removed = clearPersistedReports(window.localStorage);
    if (removed > 0) setSavedReceiptCount(countSavedDemoReceipts());
  }

  function goToView(view: WorkspaceView) {
    setActiveView(view);
    setMobileNavOpen(false);
  }

  return (
    <div className="min-h-screen bg-ofora-canvas text-ofora-ink">
      <div className="flex min-h-screen">
        <aside className="sticky top-0 hidden h-screen w-[272px] shrink-0 border-r border-ofora-deep/20 bg-ofora-deep px-4 py-5 text-white shadow-[10px_0_40px_rgba(6,53,36,0.14)] lg:block">
          <SidebarContent activeView={activeView} onChange={goToView} />
        </aside>
        <aside className="sticky top-0 hidden h-screen w-[86px] shrink-0 border-r border-ofora-deep/20 bg-ofora-deep px-3 py-5 text-white shadow-[10px_0_40px_rgba(6,53,36,0.14)] md:block lg:hidden">
          <CompactSidebar activeView={activeView} onChange={goToView} />
        </aside>
        {mobileNavOpen ? (
          <div className="fixed inset-0 z-50 md:hidden">
            <button type="button" aria-label="Close navigation overlay" className="absolute inset-0 bg-ofora-deep/45" onClick={() => setMobileNavOpen(false)} />
            <aside className="relative h-full w-[84vw] max-w-[330px] bg-ofora-deep px-4 py-5 text-white shadow-2xl">
              <div className="mb-5 flex items-center justify-between">
                <Wordmark className="text-xl text-white" />
                <button type="button" aria-label="Close workspace navigation" className="rounded-md border border-white/10 p-2 text-white/80" onClick={() => setMobileNavOpen(false)}>
                  <X className="h-4 w-4" />
                </button>
              </div>
              <SidebarContent activeView={activeView} onChange={goToView} hideBrand />
            </aside>
          </div>
        ) : null}

        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-30 border-b border-ofora-deep/10 bg-white/94 px-4 py-3 backdrop-blur-xl sm:px-6 lg:px-8">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <button type="button" aria-label="Open workspace navigation" className="rounded-md border border-ofora-deep/15 bg-white p-2 text-ofora-ink shadow-sm md:hidden" onClick={() => setMobileNavOpen(true)}>
                  <Menu className="h-5 w-5" />
                </button>
                <Link href="/" className="hidden shrink-0 text-xl md:block lg:hidden">
                  <Wordmark />
                </Link>
                <div className="min-w-0">
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-ofora-green">Procurement integrity operations</p>
                  <div className="flex items-center gap-2">
                    <h1 className="truncate text-lg font-black text-ofora-deep sm:text-xl">{activeView}</h1>
                    <span className="hidden rounded-full bg-ofora-lime px-2 py-0.5 text-xs font-black text-ofora-deep sm:inline">
                      Confidential tender validation
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                <label className="flex h-10 min-w-0 items-center gap-2 rounded-md border border-ofora-border bg-white px-3 text-sm text-ofora-muted shadow-sm lg:w-[340px]">
                  <Search className="h-4 w-4 shrink-0 text-ofora-green" />
                  <input aria-label="Search Ofora workspace" placeholder="Search tenders, suppliers, receipts..." className="min-w-0 flex-1 bg-transparent text-ofora-ink outline-none placeholder:text-ofora-muted/70" />
                </label>
                <div className="flex flex-wrap gap-2">
                  <TrustBadge tone="mint">Synthetic tender only</TrustBadge>
                  <EnvironmentBadge demoMode={demoMode} realReceiptCount={realReceiptCount} hasSimulatedFallback={hasSimulatedFallback} />
                </div>
              </div>
            </div>
          </header>

          <main className="px-4 py-5 sm:px-6 lg:px-8">
            {activeView === "Overview" ? (
              <OverviewView tender={tenderPacket} selectedSupplierScore={selectedSupplier?.score} riskCount={riskCount} deliveredCount={deliveredCount} agents={displayAgents} runStatus={runStatus} error={error} run={run} demoMode={demoMode} validationDisabledReason={livePreflightIssue ?? (runStatus === "failed" && recoverablePaidOrder ? "Recover unresolved paid order before retrying." : null)} canRecoverCompletedOrder={envStatus.policyLockLiveEnabled && runStatus === "idle"} onStartRun={startRun} onRecoverCompletedOrder={() => recoverCompletedOrder(DEFAULT_RECOVERABLE_POLICY_LOCK_ORDER_ID)} onNavigate={goToView} />
            ) : null}
            {activeView === "Validation Runs" ? (
              <ValidationRunsView agents={displayAgents} demoMode={demoMode} liveAgentNames={envStatus.liveAgentNames} policyLockLiveEnabled={envStatus.policyLockLiveEnabled} runStatus={runStatus} error={error} validationDisabledReason={livePreflightIssue ?? (runStatus === "failed" && recoverablePaidOrder ? "Recover unresolved paid order before retrying." : null)} deliveredCount={deliveredCount} run={run} onStartRun={startRun} onRecoverCompletedOrder={recoverCompletedOrder} onClearRecoveredRun={clearRecoveredRun} />
            ) : null}
            {activeView === "Tender Packet" ? <TenderPacketView tender={tenderPacket} riskCount={riskCount} validationDisabledReason={livePreflightIssue} onStartRun={startRun} onNavigate={goToView} /> : null}
            {activeView === "Suppliers" ? <SuppliersView tender={tenderPacket} /> : null}
            {activeView === "Receipts" ? <ReceiptsView tender={tenderPacket} agents={displayAgents} demoMode={demoMode} liveAgentNames={envStatus.liveAgentNames} policyLockLiveEnabled={envStatus.policyLockLiveEnabled} realReceiptCount={realReceiptCount} run={run} /> : null}
            {activeView === "Audit Boundaries" ? <AuditBoundariesView /> : null}
            {activeView === "Settings" ? <SettingsView envStatus={envStatus} run={run} savedReceiptCount={savedReceiptCount} onClearRecoveredRun={clearRecoveredRun} onClearSavedDemoReceipts={clearSavedDemoReceipts} /> : null}
          </main>
        </div>
      </div>
    </div>
  );
}

const initialAgents: AgentRun[] = agentNames.map((name) => ({
  name,
  price: AGENT_PRICES[name],
  status: "waiting"
}));

function OverviewView({
  tender,
  selectedSupplierScore,
  riskCount,
  deliveredCount,
  agents,
  runStatus,
  error,
  run,
  demoMode,
  validationDisabledReason,
  canRecoverCompletedOrder,
  onStartRun,
  onRecoverCompletedOrder,
  onNavigate
}: {
  tender: TenderPacketInput;
  selectedSupplierScore?: number;
  riskCount: number;
  deliveredCount: number;
  agents: AgentRun[];
  runStatus: ReliableRunStatus;
  error: string | null;
  run: OrchestrationRun | null;
  demoMode: boolean;
  validationDisabledReason: string | null;
  canRecoverCompletedOrder: boolean;
  onStartRun: () => void;
  onRecoverCompletedOrder: () => void;
  onNavigate: (view: WorkspaceView) => void;
}) {
  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-ofora-border bg-white p-5 shadow-panel sm:p-7">
        <TrustBadge tone="mint">{SYNTHETIC_CASE_NOTICE}</TrustBadge>
        <h2 className="mt-4 text-4xl font-black tracking-[-0.045em] text-ofora-deep sm:text-5xl">Ofora Agents workspace.</h2>
        <p className="mt-4 max-w-3xl text-base leading-7 text-ofora-muted sm:text-lg">
          Coordinate paid specialist agents to validate a confidential procurement award and generate a Fair Award Receipt.
        </p>
      </section>
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Managed value" value={`$${tender.managedValueUsd.toLocaleString()}`} detail="Emergency procurement" />
        <SummaryCard label="Specialist spend" value={SPECIALIST_SPEND} detail="Allocated across five agents" />
        <SummaryCard label="Agents in pipeline" value="5" detail={`Delivered: ${deliveredCount}`} />
        <SummaryCard label="Award status" value={formatTenderStatus(tender.status)} detail="Pending validation" />
      </section>
      <section className="grid gap-5 xl:grid-cols-2">
          <Panel title="Current tender packet" icon={ClipboardList} eyebrow="Synthetic procurement packet" showIcon={false}>
          <div className="grid gap-3 sm:grid-cols-2">
            <InfoTile label="Tender" value={tender.title} className="sm:col-span-2" />
            <InfoTile label="Tender ID" value={tender.tenderId} />
            <InfoTile label="Buyer" value={tender.buyer} className="sm:col-span-2" />
            <InfoTile label="Selected supplier" value={tender.selectedSupplier} />
            <InfoTile label="Selected score" value={selectedSupplierScore ? String(selectedSupplierScore) : "Pending"} />
            <InfoTile label="Suppliers" value={String(tender.suppliers.length)} />
            <InfoTile label="Risk flags" value={formatReviewCount(riskCount)} />
          </div>
          <Button variant="secondary" className="mt-4 border-ofora-border bg-white text-ofora-ink hover:bg-ofora-mist" onClick={() => onNavigate("Tender Packet")}>
            View tender packet
            <ArrowRight className="h-4 w-4" />
          </Button>
        </Panel>
        <Panel title="Active validation" icon={Activity} eyebrow="Coordinator run" showIcon={false}>
          <Button onClick={onStartRun} disabled={runStatus === "running" || Boolean(validationDisabledReason)} className="h-12 w-full">
            {getGenerateButtonLabel(runStatus)}
            <ArrowRight className="h-4 w-4" />
          </Button>
          {validationDisabledReason ? <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{validationDisabledReason}</div> : null}
          {canRecoverCompletedOrder ? (
            <Button type="button" variant="secondary" onClick={onRecoverCompletedOrder} className="mt-3 w-full border-ofora-border bg-white text-ofora-ink hover:bg-ofora-mist">
              Recover completed CAP order
            </Button>
          ) : null}
          {runStatus === "failed" ? <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error ?? "Validation did not complete."}</div> : null}
          <div className="mt-4 rounded-lg border border-ofora-deep/10 bg-ofora-mist p-4">
            <div className="text-sm font-black text-ofora-ink">Coordinator readiness</div>
            <p className="mt-2 text-[0.94rem] leading-6 text-ofora-muted">{deliveredCount}/5 agents delivered. ReceiptWriter waits for upstream validation outputs.</p>
            <ProgressBar value={(deliveredCount / 5) * 100} />
          </div>
          <CompactAgentList agents={agents} demoMode={demoMode} />
          <Button variant="secondary" className="mt-4 border-ofora-border bg-white text-ofora-ink hover:bg-ofora-mist" onClick={() => onNavigate("Validation Runs")}>
            View validation details
            <ArrowRight className="h-4 w-4" />
          </Button>
        </Panel>
      </section>
      <Panel title="Recent activity" icon={ReceiptText} eyebrow="Audit event log" showIcon={false}>
        <ActivityList agents={agents} runStatus={runStatus} run={run} />
      </Panel>
    </div>
  );
}

function ValidationRunsView({ agents, demoMode, liveAgentNames, policyLockLiveEnabled, runStatus, error, validationDisabledReason, deliveredCount, run, onStartRun, onRecoverCompletedOrder, onClearRecoveredRun }: { agents: AgentRun[]; demoMode: boolean; liveAgentNames: AgentName[]; policyLockLiveEnabled: boolean; runStatus: ReliableRunStatus; error: string | null; validationDisabledReason: string | null; deliveredCount: number; run: OrchestrationRun | null; onStartRun: () => void; onRecoverCompletedOrder: (orderId?: string) => void; onClearRecoveredRun: () => void }) {
  const recoverableOrderId = getRecoverableOrderId(agents);
  const canRecoverDelivery = policyLockLiveEnabled && ((runStatus === "failed" && Boolean(recoverableOrderId) && !hasValidReceipt(run)) || runStatus === "idle");
  const recovered = Boolean(run?.runId.startsWith("recovered-"));
  return (
    <div className="space-y-5">
      <ViewHeader title="Validation run / agent network" body="Inspect specialist validation state, CAP lifecycle references, payment economics, and the dependency order for the award validation run." />
      <section className="grid gap-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className="space-y-5 lg:sticky lg:top-[104px] lg:self-start">
          <Panel title="Run control" icon={Activity} eyebrow="Paid specialist coordination" showIcon={false}>
            <Button onClick={onStartRun} disabled={runStatus === "running" || Boolean(validationDisabledReason)} className="h-12 w-full">
              {getGenerateButtonLabel(runStatus)}
              <ArrowRight className="h-4 w-4" />
            </Button>
            {validationDisabledReason ? <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{validationDisabledReason}</div> : null}
            {canRecoverDelivery ? (
              <Button type="button" variant="secondary" onClick={() => onRecoverCompletedOrder(recoverableOrderId ?? DEFAULT_RECOVERABLE_POLICY_LOCK_ORDER_ID)} className="mt-3 w-full border-ofora-border bg-white text-ofora-ink hover:bg-ofora-mist">
                Recover completed CAP order
              </Button>
            ) : null}
            {recovered ? (
              <Button type="button" variant="secondary" onClick={onClearRecoveredRun} className="mt-3 w-full border-ofora-border bg-white text-ofora-ink hover:bg-ofora-mist">
                Clear recovered run
              </Button>
            ) : null}
            {runStatus === "completed" && run ? (
              <Link href={`/report/${run.runId}`} className="mt-3 block">
                <Button variant="secondary" className="w-full border-ofora-border bg-white text-ofora-ink hover:bg-ofora-mist">Open Fair Award Receipt</Button>
              </Link>
            ) : null}
            {runStatus === "failed" ? <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error ?? "Validation did not complete."}</div> : null}
          </Panel>
          <CoordinatorSummary runStatus={runStatus} deliveredCount={deliveredCount} />
          <EconomicsPanel />
          <DependencyFlow agents={agents} demoMode={demoMode} liveAgentNames={liveAgentNames} />
        </div>
        <Panel title="Agent stack" icon={ReceiptText} eyebrow="Specialist lifecycle" showIcon={false}>
          <AgentStack agents={agents} demoMode={demoMode} liveAgentNames={liveAgentNames} />
        </Panel>
      </section>
    </div>
  );
}

function TenderPacketView({ tender, riskCount, validationDisabledReason, onStartRun, onNavigate }: { tender: TenderPacketInput; riskCount: number; validationDisabledReason: string | null; onStartRun: () => void; onNavigate: (view: WorkspaceView) => void }) {
  const totalPolicyWeight = tender.lockedPolicy.criteria.reduce((total, criterion) => total + criterion.weight, 0);

  function runAwardValidation() {
    onStartRun();
    onNavigate("Validation Runs");
  }

  return (
    <div className="space-y-5">
      <ViewHeader title="Tender packet" body="Synthetic procurement packet used by Ofora specialist agents. This is demo data, not confidential submission data." />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <Button type="button" onClick={runAwardValidation} disabled={Boolean(validationDisabledReason)} className="h-11">
          Run award validation
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button type="button" variant="secondary" onClick={() => onNavigate("Suppliers")} className="h-11 border-ofora-border bg-white text-ofora-ink hover:bg-ofora-mist">
          View suppliers
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
      <Panel title="Tender details" icon={ClipboardList} eyebrow="Tender packet" showIcon={false}>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <InfoTile label="Tender" value={tender.title} className="md:col-span-2" />
          <InfoTile label="Tender ID" value={tender.tenderId} />
          <InfoTile label="Status" value={<AwardStatusBadge status={tender.status} />} />
          <InfoTile label="Buyer" value={tender.buyer} className="md:col-span-2" />
          <InfoTile label="Selected supplier" value={tender.selectedSupplier} />
          <InfoTile label="Managed value" value={`$${tender.managedValueUsd.toLocaleString()}`} />
          <InfoTile label="Policy locked at" value={formatPolicyLockedAt(tender.lockedPolicy.lockedAt)} className="md:col-span-2" />
          <RiskChecksTile count={riskCount} onNavigate={() => onNavigate("Suppliers")} />
          <InfoTile label="Suppliers" value={`${tender.suppliers.length} submitted`} />
        </div>
      </Panel>
      <Panel title="Locked evaluation policy" icon={ShieldCheck} eyebrow={`${tender.lockedPolicy.criteria.length} criteria · Total weight: ${totalPolicyWeight}%`} showIcon={false}>
        <div className="overflow-x-auto rounded-lg border border-ofora-border">
          <table className="w-full min-w-[680px] text-left text-[0.94rem]">
            <thead className="bg-ofora-mist text-[0.72rem] uppercase tracking-[0.12em] text-ofora-green">
              <tr><th className="px-4 py-3.5">Criterion</th><th className="px-4 py-3.5">Weight</th><th className="px-4 py-3.5">Locked requirement</th></tr>
            </thead>
            <tbody className="divide-y divide-ofora-border bg-white">
              {tender.lockedPolicy.criteria.map((criterion) => (
                <tr key={criterion.name}><td className="px-4 py-3.5 font-semibold">{criterion.name}</td><td className="px-4 py-3.5">{criterion.weight}%</td><td className="px-4 py-3.5 leading-6 text-ofora-muted">{criterion.description}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 rounded-md border border-ofora-deep/10 bg-ofora-mist px-3 py-2 text-[0.94rem] leading-6 text-ofora-muted">
          Synthetic tender packet. Not confidential procurement data. Held only in client state and server memory for this demo.
        </p>
      </Panel>
    </div>
  );
}

function SuppliersView({ tender }: { tender: TenderPacketInput }) {
  return (
    <div className="space-y-5">
      <ViewHeader title="Suppliers" body="Normalized synthetic supplier submissions for award validation." />
      <div className="grid gap-4 lg:grid-cols-3">
        {tender.suppliers.map((supplier) => (
          <Panel key={supplier.name} title={supplier.name} icon={Users} eyebrow={supplier.name === tender.selectedSupplier ? "Selected supplier" : "Submitted supplier"}>
            <div className="grid gap-2 text-sm">
              <FinanceRow label="Bid band" value={getBidBandLabel(supplier.bidAmountUsd, tender.managedValueUsd)} />
              <FinanceRow label="Delivery days" value={String(supplier.deliveryDays)} />
              <FinanceRow label="Score" value={supplier.score ? String(supplier.score) : "withheld"} />
              <FinanceRow label="Documents" value={String(supplier.documents.length)} />
              <FinanceRow label="Declared conflicts" value={supplier.declaredConflicts ? "Yes" : "No"} />
            </div>
            <div className="mt-4 space-y-2">
              {getSupplierRiskNotes(supplier).map((note) => <div key={note} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{note}</div>)}
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}

function ReceiptsView({ tender, agents, demoMode, liveAgentNames, policyLockLiveEnabled, realReceiptCount, run }: { tender: TenderPacketInput; agents: AgentRun[]; demoMode: boolean; liveAgentNames: AgentName[]; policyLockLiveEnabled: boolean; realReceiptCount: number; run: OrchestrationRun | null }) {
  const title = demoMode ? "Demo-mode receipts" : realReceiptCount === 0 ? "CAP receipts pending" : realReceiptCount < agentNames.length ? "Verified CAP receipts + simulated references" : "Verified CAP receipts";
  const body = demoMode ? "Simulated CAP lifecycle — no on-chain transaction was submitted." : realReceiptCount === 0 ? "Live CAP mode is enabled, but no verified receipt has been returned yet." : "Verified CROO/Base references are shown only when available.";
  const deliveredCount = agents.filter((agent) => agent.status === "delivered").length;
  const receiptReady = hasValidReceipt(run);
  return (
    <div className="space-y-5">
      <ViewHeader title={title} body={body} />
      {receiptReady && run ? (
        <div className="flex justify-end">
          <Link href={`/report/${run.runId}`}>
            <Button className="h-11">
              Open Fair Award Receipt
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      ) : null}
      <Panel title="CAP order records" icon={ReceiptText} eyebrow={demoMode ? "Simulated provenance" : "Live receipt status"} showIcon={false}>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <ReceiptContextItem label="Tender ID" value={tender.tenderId} />
          <ReceiptContextItem label="Validation run ID" value={run?.runId ?? "Not generated yet"} />
          <ReceiptContextItem label="Agents delivered" value={`${deliveredCount} / ${agentNames.length}`} />
          <ReceiptContextItem label="Specialist spend" value={SPECIALIST_SPEND} />
          <ReceiptContextItem label="Mode" value={demoMode ? "Demo simulation" : realReceiptCount === 0 ? "Live awaiting receipts" : realReceiptCount < agentNames.length ? "Mixed mode" : "LIVE CAP"} />
          {!demoMode && realReceiptCount > 0 ? <ReceiptContextItem label="Live specialist payments" value={getLiveSpecialistPayments(agents)} /> : null}
        </div>
        <ReceiptLog agents={agents} demoMode={demoMode} liveAgentNames={liveAgentNames} policyLockLiveEnabled={policyLockLiveEnabled} realReceiptCount={realReceiptCount} />
      </Panel>
    </div>
  );
}

function AuditBoundariesView() {
  return (
    <div className="space-y-5">
      <ViewHeader title="Audit boundaries" body="Ofora Agents supports procurement award review. It does not replace institutional authority." />
      <section className="rounded-lg border border-ofora-deep/10 bg-ofora-deep p-5 text-white shadow-[0_18px_50px_rgba(6,53,36,0.16)]">
        <div className="mb-4 flex items-center gap-2 font-black"><ShieldCheck className="h-4 w-4 text-ofora-lime" /> What Ofora Agents does not do</div>
        <div className="grid gap-3 text-sm text-white/85 sm:grid-cols-2 xl:grid-cols-4">
          <SafetyBoundary text="Does not expose confidential supplier bids" />
          <SafetyBoundary text="Does not replace procurement officers" />
          <SafetyBoundary text="Does not guarantee legal compliance" />
          <SafetyBoundary text="Does not store supplier secrets in demo mode" />
          <SafetyBoundary text="Does not publish raw commercial proposals" />
        </div>
      </section>
      <Panel title="Trust boundary" icon={ShieldCheck} eyebrow="Procurement integrity">
        <p className="text-sm leading-6 text-ofora-muted">{SAFETY_DISCLAIMER}</p>
      </Panel>
    </div>
  );
}

function SettingsView({
  envStatus,
  run,
  savedReceiptCount,
  onClearRecoveredRun,
  onClearSavedDemoReceipts
}: {
  envStatus: EnvStatus;
  run: OrchestrationRun | null;
  savedReceiptCount: number;
  onClearRecoveredRun: () => void;
  onClearSavedDemoReceipts: () => void;
}) {
  const demoMode = envStatus.demoMode;
  const recovered = Boolean(run?.runId.startsWith("recovered-"));
  return (
    <div className="space-y-5">
      <ViewHeader title="Settings" body="Hackathon configuration summary. Secret values are never displayed." />
      <Panel title="Environment" icon={Settings} eyebrow="Runtime configuration">
        <div className="grid gap-3 md:grid-cols-2">
          <SettingRow label="Environment mode" value={demoMode ? "Demo mode" : envStatus.policyLockLiveEnabled ? "Mixed live/demo" : "Live CAP mode"} ok />
          <SettingRow label="DEMO_MODE status" value={demoMode ? "true" : "false"} ok />
          <SettingRow label="PolicyLock live" value={demoMode ? "Disabled for demo mode" : envStatus.policyLockLiveEnabled ? "Enabled" : "Disabled"} ok={demoMode || envStatus.policyLockLiveEnabled} />
          <SettingRow label="BidNormalizer live" value={demoMode ? "Disabled for demo mode" : envStatus.bidNormalizerLiveEnabled ? "Enabled" : "Disabled"} ok={demoMode || envStatus.bidNormalizerLiveEnabled} />
          <SettingRow label="SupplierRisk live" value={demoMode ? "Disabled for demo mode" : envStatus.supplierRiskLiveEnabled ? "Enabled" : "Disabled"} ok={demoMode || envStatus.supplierRiskLiveEnabled} />
          <SettingRow label="LIVE_SPECIALISTS status" value={demoMode ? "Disabled for demo mode" : envStatus.liveSpecialistsConfigured ? "Enabled" : "Disabled"} ok={demoMode || envStatus.liveSpecialistsConfigured} />
          <SettingRow label="CROO API" value={demoMode ? "Not required in demo mode" : envStatus.crooConfigured ? "Configured" : "Missing"} ok={demoMode || envStatus.crooConfigured} />
          <SettingRow label="Coordinator SDK key" value={demoMode ? "Not required in demo mode" : envStatus.coordinatorKeyConfigured ? "Configured" : "Missing"} ok={demoMode || envStatus.coordinatorKeyConfigured} />
          <SettingRow label="PolicyLock service ID" value={demoMode ? "Not required in demo mode" : envStatus.policyServiceConfigured ? "Configured" : "Missing"} ok={demoMode || envStatus.policyServiceConfigured} />
          <SettingRow label="BidNormalizer SDK key" value={demoMode ? "Not required in demo mode" : envStatus.bidNormalizerKeyConfigured ? "Configured" : "Missing"} ok={demoMode || envStatus.bidNormalizerKeyConfigured} />
          <SettingRow label="BidNormalizer service ID" value={demoMode ? "Not required in demo mode" : envStatus.bidNormalizerServiceConfigured ? "Configured" : "Missing"} ok={demoMode || envStatus.bidNormalizerServiceConfigured} />
          <SettingRow label="SupplierRisk SDK key" value={demoMode ? "Not required in demo mode" : envStatus.supplierRiskKeyConfigured ? "Configured" : "Missing"} ok={demoMode || envStatus.supplierRiskKeyConfigured} />
          <SettingRow label="SupplierRisk service ID" value={demoMode ? "Not required in demo mode" : envStatus.supplierRiskServiceConfigured ? "Configured" : "Missing"} ok={demoMode || envStatus.supplierRiskServiceConfigured} />
          <SettingRow label="Live fallback" value={envStatus.liveFallbackEnabled ? "Enabled" : "Disabled"} ok />
          <SettingRow label="OpenAI" value={demoMode ? "Not required in demo mode" : envStatus.openaiConfigured ? "Configured" : "Missing"} ok={demoMode || envStatus.openaiConfigured} />
        </div>
      </Panel>
      <Panel title="Recovered run controls" icon={Settings} eyebrow="Local workspace state" showIcon={false}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-sm leading-6 text-ofora-muted">
            Clear only the browser&apos;s safe recovered run state. This does not modify CROO orders, payments, delivery records, or blockchain references.
          </p>
          <Button type="button" variant="secondary" onClick={onClearRecoveredRun} disabled={!recovered} className="border-ofora-border bg-white text-ofora-ink hover:bg-ofora-mist">
            Clear recovered run
          </Button>
        </div>
      </Panel>
      <Panel title="Saved demo receipts" icon={Settings} eyebrow="Browser report fallback" showIcon={false}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-sm leading-6 text-ofora-muted">
            Clear only browser-saved Fair Award Receipt fallbacks. This removes `ofora-agents:report:*` keys and does not modify CROO orders, payments, delivery records, or blockchain references.
          </p>
          <Button type="button" variant="secondary" onClick={onClearSavedDemoReceipts} disabled={savedReceiptCount === 0} className="border-ofora-border bg-white text-ofora-ink hover:bg-ofora-mist">
            Clear saved demo receipts
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function SidebarContent({ activeView, onChange, hideBrand = false }: { activeView: WorkspaceView; onChange: (view: WorkspaceView) => void; hideBrand?: boolean }) {
  return (
    <div className="flex h-full flex-col">
      {!hideBrand ? <Link href="/" className="mb-7 inline-flex text-2xl"><Wordmark className="text-white" /></Link> : null}
      <nav className="space-y-1">
        {sidebarItems.map((item) => {
          const Icon = item.icon;
          const active = item.label === activeView;
          return (
            <button key={item.label} type="button" onClick={() => onChange(item.label)} aria-current={active ? "page" : undefined} className={cn("flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm font-semibold transition", active ? "bg-white text-ofora-deep shadow-sm" : "text-white/70 hover:bg-white/[0.08] hover:text-white")}>
              <Icon className="h-4 w-4 shrink-0" />{item.label}
            </button>
          );
        })}
      </nav>
      <div className="mt-auto rounded-lg border border-white/10 bg-white/[0.08] p-4">
        <p className="text-sm font-semibold text-white">Confidentiality-first scope</p>
        <p className="mt-2 text-xs leading-5 text-white/70">Award validation support for procurement teams. Synthetic data remains the active demo boundary.</p>
      </div>
    </div>
  );
}

function CompactSidebar({ activeView, onChange }: { activeView: WorkspaceView; onChange: (view: WorkspaceView) => void }) {
  return (
    <div className="flex h-full flex-col items-center gap-5">
      <Link href="/" aria-label="Ofora home" className="ofora-focus rounded-md">
        <OforaBrand markOnly className="text-white" markClassName="h-10 w-10 min-[380px]:h-10 min-[380px]:w-10" />
      </Link>
      <nav className="flex flex-col gap-2">
        {sidebarItems.map((item) => {
          const Icon = item.icon;
          const active = item.label === activeView;
          return <button key={item.label} type="button" title={item.label} aria-label={item.label} onClick={() => onChange(item.label)} className={cn("rounded-md p-3 transition", active ? "bg-white text-ofora-deep" : "text-white/70 hover:bg-white/[0.08] hover:text-white")}><Icon className="h-4 w-4" /></button>;
        })}
      </nav>
    </div>
  );
}

function EnvironmentBadge({ demoMode, realReceiptCount, hasSimulatedFallback }: { demoMode: boolean; realReceiptCount: number; hasSimulatedFallback: boolean }) {
  if (demoMode) return <TrustBadge tone="amber">DEMO MODE · Simulated receipts</TrustBadge>;
  if (realReceiptCount === 0) return <TrustBadge tone="blue">LIVE CAP ENABLED · Awaiting first receipt</TrustBadge>;
  if (hasSimulatedFallback) return <TrustBadge tone="amber">MIXED MODE · {realReceiptCount} live receipt(s)</TrustBadge>;
  return <TrustBadge tone="blue">LIVE CAP · Base settlement</TrustBadge>;
}

function ViewHeader({ title, body }: { title: string; body: string }) {
  return <section className="rounded-lg border border-ofora-border bg-white p-5 shadow-panel sm:p-6"><h2 className="text-3xl font-black tracking-[-0.04em] text-ofora-deep sm:text-4xl">{title}</h2><p className="mt-3 max-w-3xl text-sm leading-6 text-ofora-muted sm:text-base">{body}</p></section>;
}

function TrustBadge({ children, tone }: { children: ReactNode; tone: "mint" | "amber" | "blue" | "slate" }) {
  return <span className={cn("inline-flex items-center rounded-full border px-3 py-1 text-xs font-black", tone === "mint" && "border-ofora-deep/10 bg-ofora-mist text-ofora-green", tone === "amber" && "border-amber-200 bg-amber-50 text-amber-800", tone === "blue" && "border-ofora-verify/25 bg-ofora-mist text-ofora-green", tone === "slate" && "border-ofora-border bg-ofora-soft text-ofora-muted")}>{children}</span>;
}

function SummaryCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="rounded-lg border border-ofora-border bg-white p-4 shadow-[0_12px_30px_rgba(20,35,28,0.04)]"><div className="text-[0.72rem] font-black uppercase tracking-[0.16em] text-ofora-green/80">{label}</div><div className="mt-3 text-2xl font-black tracking-[-0.02em] text-ofora-deep">{value}</div><div className="mt-1 text-[0.94rem] leading-6 text-ofora-muted">{detail}</div></div>;
}

function Panel({ title, eyebrow, icon: Icon, children, className, showIcon = true }: { title: string; eyebrow: string; icon: ElementType; children: ReactNode; className?: string; showIcon?: boolean }) {
  return <section className={cn("rounded-lg border border-ofora-border bg-white p-5 shadow-[0_12px_36px_rgba(20,35,28,0.05)]", className)}><div className="mb-5 flex items-start justify-between gap-4"><div><p className="text-[0.72rem] font-black uppercase tracking-[0.16em] text-ofora-green/80">{eyebrow}</p><h3 className="mt-1 text-xl font-black text-ofora-deep">{title}</h3></div>{showIcon ? <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-ofora-deep/10 bg-ofora-mist text-ofora-green"><Icon className="h-5 w-5" /></span> : null}</div>{children}</section>;
}

function InfoTile({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return <div className={cn("rounded-lg border border-ofora-border bg-white p-3", className)}><div className="text-[0.72rem] font-black uppercase tracking-[0.14em] text-ofora-muted">{label}</div><div className="mt-1 text-[0.94rem] leading-6 text-ofora-ink">{value}</div></div>;
}

function RiskChecksTile({ count, onNavigate }: { count: number; onNavigate: () => void }) {
  return (
    <div className="rounded-lg border border-ofora-border bg-white p-3">
      <div className="text-[0.72rem] font-black uppercase tracking-[0.14em] text-ofora-muted">Risk checks</div>
      <div className="mt-1 text-[0.94rem] leading-6 text-ofora-ink">{formatReviewCount(count)}</div>
      <button type="button" onClick={onNavigate} className="mt-2 text-xs font-black text-ofora-green underline decoration-ofora-green/30 underline-offset-4 transition hover:text-ofora-deep">
        Review supplier signals
      </button>
    </div>
  );
}

function AwardStatusBadge({ status }: { status: TenderPacketInput["status"] }) {
  const label = formatTenderStatus(status);
  return (
    <span className={cn("inline-flex rounded-full border px-2.5 py-1 text-xs font-black", status === "award_pending_validation" && "border-amber-200 bg-amber-50 text-amber-800", status === "validated" && "border-ofora-verify/25 bg-ofora-mist text-ofora-green", status === "flagged" && "border-red-200 bg-red-50 text-red-700")}>
      {label}
    </span>
  );
}

function CoordinatorSummary({ runStatus, deliveredCount }: { runStatus: ReliableRunStatus; deliveredCount: number }) {
  return <div className="rounded-lg border border-ofora-deep/10 bg-ofora-mist p-4"><div className="flex items-center justify-between gap-3"><div className="font-black text-ofora-ink">Coordinator summary</div><span className="rounded-full bg-white px-2 py-1 text-xs font-black text-ofora-green">{runStatus === "idle" ? "Ready" : sentenceCase(runStatus)}</span></div><p className="mt-2 text-[0.94rem] leading-6 text-ofora-muted">PolicyLock, BidNormalizer, and SupplierRisk run in parallel. AwardVerifier checks the selected supplier, then ReceiptWriter generates the Fair Award Receipt.</p><ProgressBar value={(deliveredCount / 5) * 100} /></div>;
}

function EconomicsPanel() {
  return <div className="rounded-lg border border-ofora-border bg-white p-4"><div className="mb-3 font-black text-ofora-ink">Economics</div><div className="grid gap-2 text-sm"><FinanceRow label="Coordinator price" value={USER_PRICE} /><FinanceRow label="Specialist spend" value={SPECIALIST_SPEND} /><FinanceRow label="Coordinator margin" value={ORCHESTRATION_MARGIN} /></div></div>;
}

function FinanceRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3 border-t border-ofora-border pt-2 first:border-t-0 first:pt-0"><span className="text-ofora-muted">{label}</span><span className="font-black text-ofora-ink">{value}</span></div>;
}

function DependencyFlow({ agents, demoMode, liveAgentNames }: { agents: AgentRun[]; demoMode: boolean; liveAgentNames: AgentName[] }) {
  const upstream = agents.filter((agent) => ["PolicyLock", "BidNormalizer", "SupplierRisk"].includes(agent.name));
  const verifier = agents.find((agent) => agent.name === "AwardVerifier") ?? initialAgents[3];
  const receipt = agents.find((agent) => agent.name === "ReceiptWriter") ?? initialAgents[4];
  const upstreamDelivered = upstream.every((agent) => agent.status === "delivered");
  const awardDelivered = verifier.status === "delivered";
  return (
    <div className="min-w-0 rounded-lg border border-ofora-border bg-white p-4">
      <div className="mb-4 text-sm font-black text-ofora-ink">Dependency relationship</div>
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.15fr)_auto_minmax(0,0.95fr)_auto_minmax(0,0.95fr)] xl:items-center">
        <div className="grid min-w-0 gap-2 sm:grid-cols-3 xl:grid-cols-1">
          {upstream.map((agent) => <DependencyNode key={agent.name} agent={agent} demoMode={demoMode} liveAgentNames={liveAgentNames} />)}
        </div>
        <div className="flex min-w-0 items-center justify-center xl:h-full">
          <PipelineConnector label="3 parallel outputs" active={upstreamDelivered} blocked={upstream.some((agent) => agent.status === "failed")} />
        </div>
        <DependencyNode agent={verifier} demoMode={demoMode} liveAgentNames={liveAgentNames} highlight note="Waits for three upstream outputs" />
        <div className="flex min-w-0 items-center justify-center xl:h-full">
          <PipelineConnector label="Validated award output" active={awardDelivered} blocked={verifier.status === "blocked" || verifier.status === "failed"} />
        </div>
        <DependencyNode agent={receipt} demoMode={demoMode} liveAgentNames={liveAgentNames} highlight note="Waits for AwardVerifier" />
      </div>
      <p className="mt-4 text-[0.84rem] leading-5 text-ofora-muted">
        PolicyLock, BidNormalizer, and SupplierRisk run in parallel. AwardVerifier waits for all three upstream outputs. ReceiptWriter waits for AwardVerifier.
      </p>
    </div>
  );
}

function DependencyNode({ agent, demoMode, liveAgentNames, highlight = false, note }: { agent: AgentRun; demoMode: boolean; liveAgentNames: AgentName[]; highlight?: boolean; note?: string }) {
  return (
    <div className={cn("min-w-0 rounded-md border px-3 py-2.5", highlight ? "border-ofora-verify/25 bg-ofora-mist" : "border-ofora-border bg-ofora-soft", agent.status === "failed" && "border-red-200 bg-red-50/70", agent.status === "blocked" && "border-ofora-border bg-ofora-soft")}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-sm font-black text-ofora-ink">{agent.name}</span>
        <span className="shrink-0 whitespace-nowrap text-xs font-semibold text-ofora-muted">{agent.price}</span>
      </div>
      <div className="mt-1 text-[0.82rem] leading-5 text-ofora-muted">{note ?? "Runs in parallel"} · {isConfiguredLiveAgent(agent.name, demoMode, liveAgentNames) ? "LIVE CAP" : "Simulated fallback"} · {getStatusLabel(agent.status, demoMode)}</div>
    </div>
  );
}

function PipelineConnector({ label, active, blocked }: { label: string; active: boolean; blocked: boolean }) {
  return (
    <div className="flex w-full min-w-0 flex-col items-center gap-2 text-center xl:w-16 xl:flex-row xl:justify-center">
      <div className={cn("h-8 w-px xl:h-px xl:w-8", blocked ? "bg-red-300" : active ? "bg-ofora-verify" : "bg-ofora-border")} aria-hidden="true" />
      <div className="min-w-0 rounded-full border border-ofora-border bg-white px-2 py-1 text-[0.68rem] font-black uppercase tracking-[0.08em] text-ofora-muted xl:hidden">{label}</div>
      <div className={cn("h-8 w-px xl:h-px xl:w-8", blocked ? "bg-red-300" : active ? "bg-ofora-verify" : "bg-ofora-border")} aria-hidden="true" />
    </div>
  );
}

function CompactAgentList({ agents, demoMode }: { agents: AgentRun[]; demoMode: boolean }) {
  return <div className="mt-4 grid gap-2">{agents.map((agent) => <div key={agent.name} className="flex items-center justify-between gap-3 rounded-md border border-ofora-border bg-white px-3 py-2.5"><div className="min-w-0"><div className="text-sm font-black text-ofora-ink">{agent.name}</div><div className="mt-0.5 text-[0.82rem] leading-5 text-ofora-muted">{getAgentDependencyLabel(agent.name)} · {agent.price}</div></div><StatusChip status={agent.status} demoMode={demoMode} /></div>)}</div>;
}

function AgentStack({ agents, demoMode, liveAgentNames }: { agents: AgentRun[]; demoMode: boolean; liveAgentNames: AgentName[] }) {
  const sorted = agentNames.map((name) => agents.find((agent) => agent.name === name)).filter((agent): agent is AgentRun => Boolean(agent));
  return <div className="space-y-2">{sorted.map((agent) => <AgentCard key={agent.name} agent={agent} demoMode={demoMode} liveAgentNames={liveAgentNames} />)}</div>;
}

function AgentCard({ agent, demoMode, liveAgentNames }: { agent: AgentRun; demoMode: boolean; liveAgentNames: AgentName[] }) {
  const refs = getAgentRefs(agent, demoMode);
  const delivered = agent.status === "delivered";
  return (
    <details className="group rounded-lg border border-ofora-border bg-white p-0 shadow-[0_10px_24px_rgba(20,35,28,0.035)] open:border-ofora-deep/15">
      <summary className="grid cursor-pointer list-none gap-3 px-4 py-3 transition hover:bg-ofora-soft/70 sm:grid-cols-[minmax(0,1.25fr)_auto_auto_auto] sm:items-center [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <div className="truncate text-sm font-black text-ofora-ink">{agent.name}</div>
          <div className="mt-0.5 text-[0.82rem] leading-5 text-ofora-muted">{agent.price}</div>
        </div>
        <div className="justify-self-start sm:justify-self-end"><ModeBadge agent={agent} demoMode={demoMode} liveAgentNames={liveAgentNames} /></div>
        <StatusChip status={agent.status} demoMode={demoMode} />
        <div className="text-[0.82rem] font-semibold text-ofora-muted sm:text-right">{formatElapsed(agent.elapsedMs)}</div>
      </summary>
      <div className="border-t border-ofora-border px-4 py-3">
        {demoMode ? <div className="mb-3 text-xs font-semibold text-amber-700">Simulated CAP payment</div> : null}
        <div className="grid gap-2 text-xs md:grid-cols-3">
          <ReferenceLine label="Order ID" value={refs.orderId} simulated={demoMode} fallback={isSimulatedFallbackAgent(agent, demoMode, liveAgentNames)} copy={delivered || demoMode || Boolean(refs.orderId)} />
          <ReferenceLine label="Receipt ref" value={refs.receiptRef} simulated={demoMode} fallback={isSimulatedFallbackAgent(agent, demoMode, liveAgentNames)} copy={delivered || demoMode || Boolean(refs.receiptRef)} />
          <ReferenceLine label="Delivery ref" value={refs.deliveryRef} simulated={demoMode} fallback={isSimulatedFallbackAgent(agent, demoMode, liveAgentNames)} />
        </div>
      </div>
    </details>
  );
}

function ModeBadge({ agent, demoMode, liveAgentNames = [] }: { agent: AgentRun; demoMode: boolean; liveAgentNames?: AgentName[] }) {
  if (demoMode) return <TrustBadge tone="amber">Demo simulation</TrustBadge>;
  if (isConfiguredLiveAgent(agent.name, demoMode, liveAgentNames)) return <TrustBadge tone="blue">LIVE CAP</TrustBadge>;
  if (hasRealReceipt(agent)) return <TrustBadge tone="blue">LIVE CAP</TrustBadge>;
  return <TrustBadge tone="slate">Simulated fallback</TrustBadge>;
}

function StatusChip({ status, demoMode = false }: { status: AgentRun["status"]; demoMode?: boolean }) {
  const delivered = status === "delivered";
  const failed = status === "failed";
  const passive = status === "blocked" || status === "not_run" || status === "waiting";
  return <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[0.82rem] font-semibold", delivered && "border-ofora-verify/25 bg-ofora-mist text-ofora-green", failed && "border-red-200 bg-red-50 text-red-700", passive && "border-ofora-border bg-ofora-soft text-ofora-muted", !delivered && !failed && !passive && "border-ofora-border bg-ofora-soft text-ofora-muted")}>{delivered ? <Check className="h-3 w-3" /> : passive ? null : <Loader2 className="h-3 w-3 animate-spin" />}{getStatusLabel(status, demoMode)}</span>;
}

function ReceiptContextItem({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-ofora-border bg-ofora-soft px-3 py-2.5"><div className="text-[0.68rem] font-black uppercase tracking-[0.14em] text-ofora-muted">{label}</div><div className="mt-1 truncate text-[0.92rem] font-black text-ofora-ink" title={value}>{value}</div></div>;
}

function ReceiptLog({ agents, demoMode, liveAgentNames, policyLockLiveEnabled, realReceiptCount }: { agents: AgentRun[]; demoMode: boolean; liveAgentNames: AgentName[]; policyLockLiveEnabled: boolean; realReceiptCount: number }) {
  const sorted = agentNames.map((name) => agents.find((agent) => agent.name === name) ?? initialAgents.find((agent) => agent.name === name)).filter((agent): agent is AgentRun => Boolean(agent));
  if (!demoMode && (policyLockLiveEnabled || realReceiptCount > 0)) {
    const liveAgents = sorted.filter(hasRealReceipt);
    const fallbackAgents = sorted.filter((agent) => !hasRealReceipt(agent));
    return (
      <div className="space-y-5">
        <ReceiptAgentGroup title={liveAgents.length === 1 ? "Verified CAP receipt" : "Verified CAP receipts"} agents={liveAgents} demoMode={demoMode} liveAgentNames={liveAgentNames} realReceiptCount={realReceiptCount} />
        <ReceiptAgentGroup title="Simulated fallback references" agents={fallbackAgents} demoMode={demoMode} liveAgentNames={liveAgentNames} realReceiptCount={realReceiptCount} />
      </div>
    );
  }
  return <ReceiptAgentGroup agents={sorted} demoMode={demoMode} liveAgentNames={liveAgentNames} realReceiptCount={realReceiptCount} />;
}

function ReceiptAgentGroup({ title, agents, demoMode, liveAgentNames, realReceiptCount }: { title?: string; agents: AgentRun[]; demoMode: boolean; liveAgentNames: AgentName[]; realReceiptCount: number }) {
  return (
    <div>
      {title ? <h4 className="mb-2 text-sm font-black text-ofora-ink">{title}</h4> : null}
      <div className="hidden overflow-x-auto rounded-lg border border-ofora-border lg:block">
        <table className="w-full min-w-[1180px] text-left text-[0.86rem]">
          <thead className="bg-ofora-mist text-[0.68rem] uppercase tracking-[0.12em] text-ofora-green">
            <tr>
              <th className="px-3 py-3">Agent</th>
              <th className="px-3 py-3">Price</th>
              <th className="px-3 py-3">Mode</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3">Order reference</th>
              <th className="px-3 py-3">Receipt reference</th>
              <th className="px-3 py-3">Delivery reference</th>
              <th className="px-3 py-3">Elapsed time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ofora-border bg-white">
            {agents.map((agent) => (
              <tr key={agent.name} className="align-top">
                <td className="px-3 py-3 font-black text-ofora-ink">{agent.name}</td>
                <td className="px-3 py-3"><AgentPriceDisplay agent={agent} /></td>
                <td className="px-3 py-3"><ModeBadge agent={agent} demoMode={demoMode} liveAgentNames={liveAgentNames} /></td>
                <td className="px-3 py-3"><StatusChip status={agent.status} demoMode={demoMode} /></td>
                <td className="px-3 py-3"><ReceiptReferenceValue agent={agent} type="order" demoMode={demoMode} liveAgentNames={liveAgentNames} realReceiptCount={realReceiptCount} /></td>
                <td className="px-3 py-3"><ReceiptReferenceValue agent={agent} type="receipt" demoMode={demoMode} liveAgentNames={liveAgentNames} realReceiptCount={realReceiptCount} /></td>
                <td className="px-3 py-3"><ReceiptReferenceValue agent={agent} type="delivery" demoMode={demoMode} liveAgentNames={liveAgentNames} realReceiptCount={realReceiptCount} /></td>
                <td className="px-3 py-3 font-semibold text-ofora-muted">{formatElapsed(agent.elapsedMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 lg:hidden">
        {agents.map((agent) => (
          <div key={agent.name} className="rounded-lg border border-ofora-border bg-white p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-black text-ofora-ink">{agent.name}</div>
                <div className="mt-1"><AgentPriceDisplay agent={agent} /></div>
              </div>
              <StatusChip status={agent.status} demoMode={demoMode} />
            </div>
            <div className="mt-3"><ModeBadge agent={agent} demoMode={demoMode} liveAgentNames={liveAgentNames} /></div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <ReceiptMobileField label="Order reference"><ReceiptReferenceValue agent={agent} type="order" demoMode={demoMode} liveAgentNames={liveAgentNames} realReceiptCount={realReceiptCount} /></ReceiptMobileField>
              <ReceiptMobileField label="Receipt reference"><ReceiptReferenceValue agent={agent} type="receipt" demoMode={demoMode} liveAgentNames={liveAgentNames} realReceiptCount={realReceiptCount} /></ReceiptMobileField>
              <ReceiptMobileField label="Delivery reference"><ReceiptReferenceValue agent={agent} type="delivery" demoMode={demoMode} liveAgentNames={liveAgentNames} realReceiptCount={realReceiptCount} /></ReceiptMobileField>
              <ReceiptMobileField label="Elapsed time"><span className="font-semibold text-ofora-muted">{formatElapsed(agent.elapsedMs)}</span></ReceiptMobileField>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReceiptMobileField({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0 rounded-md border border-ofora-border bg-ofora-soft px-3 py-2"><div className="mb-1 text-[0.68rem] font-black uppercase tracking-[0.14em] text-ofora-muted">{label}</div>{children}</div>;
}

function AgentPriceDisplay({ agent }: { agent: AgentRun }) {
  return (
    <div className="space-y-1">
      <div className="text-[0.82rem] font-semibold text-ofora-ink">{agent.price}</div>
      {agent.actualOrderPrice ? (
        <div className="text-[0.68rem] font-black uppercase tracking-[0.08em] text-ofora-muted">
          Historical settled order: {agent.actualOrderPrice}
        </div>
      ) : null}
    </div>
  );
}

function ReceiptReferenceValue({ agent, type, demoMode, liveAgentNames, realReceiptCount }: { agent: AgentRun; type: "order" | "receipt" | "delivery"; demoMode: boolean; liveAgentNames: AgentName[]; realReceiptCount: number }) {
  const refs = getAgentRefs(agent, demoMode);
  const value = type === "order" ? refs.orderId : type === "receipt" ? refs.receiptRef : refs.deliveryRef;
  const secondaryValue = type === "delivery" ? refs.providerDeliveryTxHash : undefined;
  const pendingLiveOnly = !demoMode && realReceiptCount === 0;
  const realReceipt = hasRealReceipt(agent);
  const liveConfiguredRow = isConfiguredLiveAgent(agent.name, demoMode, liveAgentNames) && !isSimulatedFallbackAgent(agent, demoMode, liveAgentNames);
  const label = demoMode ? "Simulated reference" : liveConfiguredRow || realReceipt ? "CROO/Base reference" : pendingLiveOnly ? "Pending live receipt" : value ? "Simulated fallback" : "Pending live receipt";
  const visibleValue = pendingLiveOnly && !liveConfiguredRow ? "Pending live receipt" : value ?? (liveConfiguredRow ? "Not returned by SDK" : undefined);
  return (
    <div className="min-w-0">
      <div className={cn("mb-1 text-[0.68rem] font-black uppercase tracking-[0.08em]", demoMode || (!realReceipt && !pendingLiveOnly) ? "text-amber-700" : pendingLiveOnly ? "text-ofora-muted" : "text-ofora-green")}>{label}</div>
      <div className="flex min-w-0 items-start gap-1.5">
        <span className={cn("min-w-0 max-w-[18rem] break-all font-mono text-[0.78rem] leading-5", visibleValue ? "text-ofora-ink" : "text-ofora-muted")} title={visibleValue ?? "Pending live receipt"} aria-label={visibleValue ?? "Pending live receipt"}>
          {visibleValue ?? "Pending live receipt"}
        </span>
        {visibleValue && visibleValue !== "Pending live receipt" && visibleValue !== "Not returned by SDK" ? (
          <button type="button" aria-label={`Copy ${type} reference for ${agent.name}`} title="Copy full reference" onClick={() => navigator.clipboard.writeText(visibleValue)} className="shrink-0 rounded p-1 text-ofora-muted transition hover:bg-ofora-mist hover:text-ofora-green">
            <Copy className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {secondaryValue ? (
        <div className="mt-2 min-w-0">
          <div className="mb-1 text-[0.68rem] font-black uppercase tracking-[0.08em] text-ofora-green">Provider delivery tx</div>
          <div className="flex min-w-0 items-start gap-1.5">
            <span className="min-w-0 max-w-[18rem] break-all font-mono text-[0.78rem] leading-5 text-ofora-ink" title={secondaryValue} aria-label={secondaryValue}>{secondaryValue}</span>
            <button type="button" aria-label={`Copy provider delivery transaction for ${agent.name}`} title="Copy provider delivery transaction" onClick={() => navigator.clipboard.writeText(secondaryValue)} className="shrink-0 rounded p-1 text-ofora-muted transition hover:bg-ofora-mist hover:text-ofora-green">
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReferenceLine({ label, value, simulated = false, fallback = false, copy = false }: { label: string; value?: string; simulated?: boolean; fallback?: boolean; copy?: boolean }) {
  return <div className="min-w-0 rounded-md border border-ofora-border bg-ofora-soft px-3 py-2"><div className="flex items-center justify-between gap-2"><span className="text-ofora-muted">{label}</span>{simulated ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">Simulated reference</span> : null}{fallback ? <span className="rounded-full bg-ofora-mist px-2 py-0.5 text-[10px] font-semibold text-ofora-muted">Simulated fallback</span> : null}</div><div className="mt-1 flex min-w-0 items-center gap-1 font-mono text-ofora-ink"><span className="truncate">{shortId(value)}</span>{copy && value ? <button type="button" aria-label={`Copy ${label}`} title={`Copy ${label}`} onClick={() => navigator.clipboard.writeText(value)} className="rounded p-1 text-ofora-muted hover:bg-ofora-mist hover:text-ofora-green"><Copy className="h-3 w-3" /></button> : null}</div></div>;
}

function SafetyBoundary({ text }: { text: string }) {
  return <div className="rounded-md border border-white/10 bg-white/[0.08] px-3 py-3"><div className="flex items-center gap-2"><Check className="h-4 w-4 text-ofora-lime" />{text}</div></div>;
}

function SettingRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return <div className="flex items-center justify-between gap-4 rounded-lg border border-ofora-border bg-white p-4"><div><div className="text-xs font-black uppercase tracking-[0.14em] text-ofora-muted">{label}</div><div className="mt-1 text-sm font-black text-ofora-ink">{value}</div></div><span className={cn("rounded-full border px-2 py-1 text-xs font-black", ok ? "border-ofora-verify/25 bg-ofora-mist text-ofora-green" : "border-amber-200 bg-amber-50 text-amber-800")}>{ok ? "Ready" : "Missing"}</span></div>;
}

function ActivityList({ agents, runStatus, run }: { agents: AgentRun[]; runStatus: ReliableRunStatus; run: OrchestrationRun | null }) {
  const receiptReady = hasValidReceipt(run);
  const active = (event: string) => {
    if (event === "Tender packet initialized") return true;
    if (event === "AwardVerifier completed") return hasValidAward(run);
    if (event === "Fair Award Receipt created") return runStatus === "completed" && receiptReady && Boolean(run?.runId);
    const agentName = event.replace(" delivered", "") as AgentName;
    return agents.some((agent) => agent.name === agentName && agent.status === "delivered");
  };
  const firstWaitingIndex = activityEvents.findIndex((event) => !active(event));
  return <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{activityEvents.map((event, index) => { const isActive = active(event); const isFailed = runStatus === "failed" && !isActive; const isCurrent = runStatus === "running" && index === firstWaitingIndex; const stateLabel = isActive ? "Recorded" : isFailed ? "Failed" : isCurrent ? "Active" : "Waiting"; return <div key={event} className={cn("flex min-h-[84px] gap-3 rounded-lg border bg-white p-3.5", isActive && "border-ofora-verify/25", isCurrent && "border-ofora-green/30 bg-ofora-mist/60", isFailed && "border-red-200 bg-red-50/70", !isActive && !isCurrent && !isFailed && "border-ofora-border")}><span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-black", isActive ? "border-ofora-verify/25 bg-ofora-mist text-ofora-green" : isCurrent ? "border-ofora-green/30 bg-white text-ofora-green" : isFailed ? "border-red-200 bg-white text-red-700" : "border-ofora-border bg-ofora-soft text-ofora-muted")}>{isActive ? <Check className="h-3.5 w-3.5" /> : index + 1}</span><div className="min-w-0"><div className="text-[0.94rem] font-black leading-5 text-ofora-ink">{event}</div><div className={cn("mt-1 text-[0.84rem] leading-5", isFailed ? "text-red-700" : "text-ofora-muted")}>{stateLabel}</div></div></div>; })}</div>;
}

function ProgressBar({ value }: { value: number }) {
  return <div className="mt-3 h-2 overflow-hidden rounded-full bg-white"><div className="h-full rounded-full bg-ofora-verify" style={{ width: value <= 0 ? "0%" : `${Math.max(12, value)}%` }} /></div>;
}

function getReliableRunStatus({ loading, error, run }: { loading: boolean; error: string | null; run: OrchestrationRun | null }): ReliableRunStatus {
  if (loading) return "running";
  if (error || run?.status === "failed") return "failed";
  if (run?.status === "completed") return hasValidReceipt(run) ? "completed" : "failed";
  if (run) return "running";
  return "idle";
}

function getDisplayAgents(agents: AgentRun[], runStatus: ReliableRunStatus, run: OrchestrationRun | null) {
  if (runStatus === "idle") return initialAgents;
  if (runStatus === "completed") return agents;
  if (runStatus === "failed") return agents.map((agent) => getFailedDisplayAgent(agent, run));
  return agents;
}

function markFailedAgents(current: AgentRun[]) {
  return current.map((agent) => getFailedDisplayAgent(agent, null));
}

function getGenerateButtonLabel(runStatus: ReliableRunStatus) {
  if (runStatus === "running") return "Validating...";
  if (runStatus === "completed") return "Run new validation";
  if (runStatus === "failed") return "Retry award validation";
  return "Validate award";
}

function getStatusLabel(status: AgentRun["status"], demoMode: boolean) {
  if (demoMode && status === "paid") return "Demo paid";
  if (demoMode && status === "payment_pending") return "Demo payment pending";
  if (status === "not_run") return "Not run";
  if (status === "blocked") return "Blocked";
  if (status === "confirming_delivery") return "Confirming delivery";
  return sentenceCase(status.replaceAll("_", " "));
}

function getFailedDisplayAgent(agent: AgentRun, run: OrchestrationRun | null): AgentRun {
  if (agent.status === "delivered" || agent.status === "failed" || agent.status === "blocked" || agent.status === "not_run") return agent;
  if (agent.name === "PolicyLock") return { ...agent, status: "failed" as const };
  if (agent.name === "AwardVerifier") return { ...agent, status: hasValidAward(run) ? agent.status : "blocked" as const };
  if (agent.name === "ReceiptWriter") return { ...agent, status: hasValidReceipt(run) ? agent.status : "blocked" as const, resultHash: hasValidReceipt(run) ? agent.resultHash : undefined, elapsedMs: hasValidReceipt(run) ? agent.elapsedMs : undefined };
  return agent.status === "waiting" ? { ...agent, status: "not_run" as const } : agent;
}

function clearAnimationTimers(timers: number[]) {
  timers.forEach((timer) => window.clearTimeout(timer));
  timers.length = 0;
}

function countSavedDemoReceipts() {
  let count = 0;
  for (let index = 0; index < window.localStorage.length; index += 1) {
    if (window.localStorage.key(index)?.startsWith(PERSISTED_REPORT_STORAGE_PREFIX)) count += 1;
  }
  return count;
}

function hasValidAward(run: OrchestrationRun | null) {
  return Boolean(run?.outputs?.awardVerifier?.validationSummary);
}

function hasValidReceipt(run: OrchestrationRun | null) {
  return Boolean(run?.outputs?.receiptWriter?.fairAwardReceiptSummary);
}

function hasRealReceipt(agent: AgentRun) {
  return Boolean(agent.txHash && !agent.txHash.startsWith("demo_") && !agent.txHash.startsWith("demo-") && !agent.txHash.startsWith("sim_") && !agent.txHash.startsWith("pending"));
}

function hasRecoverablePaidOrder(agents: AgentRun[]) {
  return agents.some((agent) => {
    const realOrder = agent.orderId && !isPlaceholderRef(agent.orderId);
    const realPayment = hasRealReceipt(agent);
    return (realOrder || realPayment) && !agent.resultHash && agent.status !== "delivered";
  });
}

function getLivePreflightIssue(envStatus: EnvStatus) {
  if (envStatus.demoMode || envStatus.liveAgentNames.length === 0) return null;
  if (!envStatus.crooConfigured) return "CROO API and WebSocket URLs are required before live CAP validation.";
  if (!envStatus.coordinatorKeyConfigured) return "Coordinator requester SDK key is required before live CAP validation.";
  if (envStatus.policyLockLiveEnabled && !envStatus.policyServiceConfigured) return "PolicyLock service ID is required before live CAP validation.";
  if (envStatus.bidNormalizerLiveEnabled && !envStatus.bidNormalizerServiceConfigured) return "BidNormalizer service ID is required before live CAP validation.";
  if (envStatus.supplierRiskLiveEnabled && !envStatus.supplierRiskServiceConfigured) return "SupplierRisk service ID is required before live CAP validation.";
  return null;
}

function getLiveSpecialistPayments(agents: AgentRun[]) {
  const totalCents = agents.filter(hasRealReceipt).reduce((total, agent) => total + AGENT_PRICE_CENTS[agent.name], 0);
  return formatUsdcCents(totalCents);
}

function getAgentRefs(agent: AgentRun, demoMode: boolean) {
  const slug = getAgentSlug(agent.name);
  if (demoMode) return { orderId: `demo_order_${slug}_001`, receiptRef: `demo_receipt_${slug}_001`, deliveryRef: `demo_delivery_${slug}_001` };
  return { orderId: isPlaceholderRef(agent.orderId) ? fallbackOrderRef(agent) : agent.orderId, receiptRef: isPlaceholderRef(agent.txHash) ? fallbackReceiptRef(agent) : agent.txHash, deliveryRef: isPlaceholderRef(agent.resultHash) ? fallbackDeliveryRef(agent) : agent.resultHash, providerDeliveryTxHash: isPlaceholderRef(agent.providerDeliveryTxHash) ? undefined : agent.providerDeliveryTxHash };
}

function isPlaceholderRef(value?: string) {
  return !value || value.startsWith("demo_") || value.startsWith("demo-") || value.startsWith("sim_") || value.startsWith("pending");
}

function isConfiguredLiveAgent(name: AgentName, demoMode: boolean, liveAgentNames: AgentName[]) {
  return !demoMode && liveAgentNames.includes(name);
}

function isSimulatedFallbackAgent(agent: AgentRun, demoMode: boolean, liveAgentNames: AgentName[]) {
  if (demoMode) return false;
  if (!isConfiguredLiveAgent(agent.name, demoMode, liveAgentNames)) return !hasRealReceipt(agent);
  return Boolean(agent.orderId?.startsWith("demo_") || agent.orderId?.startsWith("sim_") || agent.txHash?.startsWith("demo_") || agent.txHash?.startsWith("sim_"));
}

function getRecoverableOrderId(agents: AgentRun[]) {
  const policyLock = agents.find((agent) => agent.name === "PolicyLock");
  if (policyLock?.orderId && !isPlaceholderRef(policyLock.orderId) && !policyLock.resultHash) return policyLock.orderId;
  return undefined;
}

function fallbackOrderRef(agent: AgentRun) {
  return agent.status === "waiting" ? undefined : `sim_order_${getAgentSlug(agent.name)}_pending`;
}

function fallbackReceiptRef(agent: AgentRun) {
  return agent.status === "waiting" ? undefined : `sim_receipt_${getAgentSlug(agent.name)}_pending`;
}

function fallbackDeliveryRef(agent: AgentRun) {
  return agent.status === "delivered" ? `sim_delivery_${getAgentSlug(agent.name)}_pending` : undefined;
}

function animateAgents(setAgents: Dispatch<SetStateAction<AgentRun[]>>, demoMode: boolean, timers: number[]) {
  setAgents(initialAgents);
  agentNames.forEach((name, agentIndex) => {
    statusTimeline.forEach((status, statusIndex) => {
      const timer = window.setTimeout(() => {
        setAgents((current) => current.map((agent) => {
          const slug = getAgentSlug(name);
          return agent.name === name ? { ...agent, status, orderId: statusIndex >= 2 ? agent.orderId ?? (demoMode ? `demo_order_${slug}_001` : `pending-${slug}`) : agent.orderId, txHash: statusIndex >= 3 ? agent.txHash ?? (demoMode ? `demo_receipt_${slug}_001` : `pending-tx-${slug}`) : agent.txHash, resultHash: statusIndex >= 5 ? agent.resultHash ?? (demoMode ? `demo_delivery_${slug}_001` : `pending-delivery-${slug}`) : agent.resultHash, elapsedMs: statusIndex >= 5 ? 1200 + agentIndex * 220 : agent.elapsedMs } : agent;
        }));
      }, agentIndex * 180 + statusIndex * 420);
      timers.push(timer);
    });
  });
}

function formatTenderStatus(status: TenderPacketInput["status"]) {
  return sentenceCase(status.replaceAll("_", " "));
}

function formatPolicyLockedAt(value: string) {
  const lockedAt = new Date(value);
  if (Number.isNaN(lockedAt.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Africa/Lagos" }).format(lockedAt).replace(" at ", " · ");
}

function formatReviewCount(count: number) {
  return count === 1 ? "1 item requires review" : `${count} items require review`;
}

function sentenceCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getAgentDependencyLabel(name: AgentName) {
  if (["PolicyLock", "BidNormalizer", "SupplierRisk"].includes(name)) return "Parallel";
  return "Waits for upstream outputs";
}

function getBidBandLabel(bidAmountUsd: number, managedValueUsd: number) {
  const ratio = bidAmountUsd / managedValueUsd;
  if (ratio <= 0.98) return "below managed value";
  if (ratio <= 1.03) return "near managed value";
  return "above managed value";
}

function getSupplierRiskNotes(supplier: TenderPacketInput["suppliers"][number]) {
  const notes: string[] = [];
  if (supplier.documents.length < 4) notes.push("Submission has missing documentation.");
  if (supplier.declaredConflicts) notes.push("Declared conflict requires procurement review.");
  if (supplier.deliveryDays > 21) notes.push("Delivery timeline exceeds locked threshold.");
  return notes.length > 0 ? notes : ["No material supplier risk signal in the supplied demo packet."];
}

function getAgentSlug(name: AgentName) {
  return name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}
