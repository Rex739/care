import { z } from "zod";
import { OrchestrationRunSchema, type OrchestrationRun, type TenderPacketInput } from "@/lib/schemas/ofora";

export const PERSISTED_REPORT_STORAGE_PREFIX = "ofora-agents:report:";

const PublicTenderSummarySchema = z.object({
  tenderId: z.string().min(1),
  title: z.string().min(1),
  buyer: z.string().min(1),
  managedValueUsd: z.number(),
  selectedSupplier: z.string().min(1),
  status: z.enum(["award_pending_validation", "validated", "flagged"]),
  lockedPolicy: z.object({
    lockedAt: z.string().min(1),
    criteria: z.array(z.object({ name: z.string().min(1), weight: z.number(), description: z.string().min(1) }))
  })
});

export const PersistedReportSchema = z.object({
  version: z.literal(1),
  savedAt: z.string().min(1),
  run: OrchestrationRunSchema,
  tender: PublicTenderSummarySchema
});

export type PersistedReport = z.infer<typeof PersistedReportSchema>;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export function getPersistedReportStorageKey(runId: string) {
  return `${PERSISTED_REPORT_STORAGE_PREFIX}${runId}`;
}

export function createPersistedReport(run: OrchestrationRun, tender: TenderPacketInput, savedAt = new Date().toISOString()): PersistedReport | null {
  if (run.status !== "completed" || !run.outputs?.receiptWriter) return null;
  return PersistedReportSchema.parse({
    version: 1,
    savedAt,
    run: sanitizeRun(run),
    tender: {
      tenderId: tender.tenderId,
      title: tender.title,
      buyer: tender.buyer,
      managedValueUsd: tender.managedValueUsd,
      selectedSupplier: tender.selectedSupplier,
      status: tender.status,
      lockedPolicy: {
        lockedAt: tender.lockedPolicy.lockedAt,
        criteria: tender.lockedPolicy.criteria.map((criterion) => ({
          name: criterion.name,
          weight: criterion.weight,
          description: criterion.description
        }))
      }
    }
  });
}

export function serializePersistedReport(report: PersistedReport) {
  return JSON.stringify(PersistedReportSchema.parse(report));
}

export function parsePersistedReport(value: string | null): PersistedReport | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(value) as unknown;
    if (hasSecretShapedKey(raw)) return null;
    return PersistedReportSchema.parse(raw);
  } catch {
    return null;
  }
}

export function savePersistedReport(storage: StorageLike, run: OrchestrationRun, tender: TenderPacketInput) {
  const report = createPersistedReport(run, tender);
  if (!report) return null;
  storage.setItem(getPersistedReportStorageKey(report.run.runId), serializePersistedReport(report));
  return report;
}

export function loadPersistedReport(storage: StorageLike, runId: string) {
  const report = parsePersistedReport(storage.getItem(getPersistedReportStorageKey(runId)));
  return report?.run.runId === runId ? report : null;
}

export function loadLatestPersistedReport(storage: StorageLike) {
  const reports: PersistedReport[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(PERSISTED_REPORT_STORAGE_PREFIX)) continue;
    const report = parsePersistedReport(storage.getItem(key));
    if (report) reports.push(report);
  }
  return reports.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))[0] ?? null;
}

export function clearPersistedReports(storage: StorageLike) {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(PERSISTED_REPORT_STORAGE_PREFIX)) keys.push(key);
  }
  keys.forEach((key) => storage.removeItem(key));
  return keys.length;
}

export function resolveReportRun({
  reportId,
  serverRun,
  persisted
}: {
  reportId: string;
  serverRun: OrchestrationRun | null;
  persisted: PersistedReport | null;
}) {
  if (serverRun) return { run: OrchestrationRunSchema.parse(serverRun), recoveredFromBrowser: false };
  if (persisted?.run.runId === reportId) return { run: persisted.run, recoveredFromBrowser: true };
  return { run: null, recoveredFromBrowser: false };
}

export function getReportDisplayState({ hydrated, run }: { hydrated: boolean; run: OrchestrationRun | null }) {
  if (!hydrated) return "loading";
  return run ? "found" : "not_found";
}

function sanitizeRun(run: OrchestrationRun): OrchestrationRun {
  return OrchestrationRunSchema.parse({
    runId: run.runId,
    status: run.status,
    startedAt: run.startedAt,
    agents: run.agents.map((agent) => ({
      name: agent.name,
      price: agent.price,
      actualOrderPrice: agent.actualOrderPrice,
      status: agent.status,
      orderId: agent.orderId,
      txHash: agent.txHash,
      resultHash: agent.resultHash,
      providerDeliveryTxHash: agent.providerDeliveryTxHash,
      elapsedMs: agent.elapsedMs
    })),
    outputs: run.outputs
  });
}

function hasSecretShapedKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasSecretShapedKey);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => isSecretKey(key) || hasSecretShapedKey(child));
}

function isSecretKey(key: string) {
  return /secret|sdk[_-]?key|api[_-]?key|authorization|private|wallet|env|token/i.test(key);
}
