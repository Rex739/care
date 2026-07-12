import assert from "node:assert/strict";
import test from "node:test";
import {
  clearPersistedReports,
  createPersistedReport,
  getPersistedReportStorageKey,
  getReportDisplayState,
  loadLatestPersistedReport,
  loadPersistedReport,
  parsePersistedReport,
  PERSISTED_REPORT_STORAGE_PREFIX,
  resolveReportRun,
  savePersistedReport
} from "@/lib/reports/persisted-report";
import { demoTender } from "@/lib/demo/case";
import type { OrchestrationRun } from "@/lib/schemas/ofora";

test("successful run is serialized without secrets", () => {
  const report = createPersistedReport(
    {
      ...completedRun,
      secretToken: "do-not-save",
      agents: completedRun.agents.map((agent) => ({ ...agent, sdkKey: "croo_sk_secret" }))
    } as OrchestrationRun,
    { ...demoTender, suppliers: demoTender.suppliers.map((supplier) => ({ ...supplier, documents: ["confidential proposal.pdf"] })) },
    "2026-07-12T00:00:00.000Z"
  );

  assert.ok(report);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /secretToken|sdkKey|croo_sk_secret|confidential proposal/i);
  assert.match(serialized, /policy-order-001|0xpay-policy|delivery-policy/);
});

test("valid persisted report hydrates correctly", () => {
  const storage = createStorage();
  const saved = savePersistedReport(storage, completedRun, demoTender);

  assert.ok(saved);
  const loaded = loadPersistedReport(storage, completedRun.runId);

  assert.equal(loaded?.run.runId, completedRun.runId);
  assert.equal(loaded?.run.outputs?.receiptWriter?.receiptId, "far-001");
});

test("invalid or malformed persisted data is rejected", () => {
  assert.equal(parsePersistedReport("{bad json"), null);
  assert.equal(parsePersistedReport(JSON.stringify({ version: 1, run: { runId: "bad" } })), null);
});

test("server report takes precedence over browser report", () => {
  const persisted = createPersistedReport({ ...completedRun, runId: "browser-run" }, demoTender);
  const serverRun = { ...completedRun, runId: "server-run" };

  const resolved = resolveReportRun({ reportId: "server-run", serverRun, persisted });

  assert.equal(resolved.run?.runId, "server-run");
  assert.equal(resolved.recoveredFromBrowser, false);
});

test("missing server report falls back to localStorage", () => {
  const persisted = createPersistedReport(completedRun, demoTender);

  const resolved = resolveReportRun({ reportId: completedRun.runId, serverRun: null, persisted });

  assert.equal(resolved.run?.runId, completedRun.runId);
  assert.equal(resolved.recoveredFromBrowser, true);
});

test("latest persisted report can restore the workspace run id", () => {
  const storage = createStorage();
  const older = createPersistedReport({ ...completedRun, runId: "older-run" }, demoTender, "2026-07-11T00:00:00.000Z");
  const newer = createPersistedReport({ ...completedRun, runId: "newer-run" }, demoTender, "2026-07-12T00:00:00.000Z");
  assert.ok(older);
  assert.ok(newer);
  storage.setItem(getPersistedReportStorageKey(older.run.runId), JSON.stringify(older));
  storage.setItem(getPersistedReportStorageKey(newer.run.runId), JSON.stringify(newer));

  const restored = loadLatestPersistedReport(storage);

  assert.equal(restored?.run.runId, "newer-run");
});

test("report-not-found appears only after hydration completes", () => {
  assert.equal(getReportDisplayState({ hydrated: false, run: null }), "loading");
  assert.equal(getReportDisplayState({ hydrated: true, run: null }), "not_found");
  assert.equal(getReportDisplayState({ hydrated: true, run: completedRun }), "found");
});

test("secret-shaped properties are never accepted from persisted data", () => {
  const report = createPersistedReport(completedRun, demoTender);
  assert.ok(report);

  const poisoned = JSON.stringify({ ...report, authorization: "Bearer secret" });

  assert.equal(parsePersistedReport(poisoned), null);
});

test("clear saved demo receipts removes only report keys", () => {
  const storage = createStorage();
  storage.setItem(getPersistedReportStorageKey(completedRun.runId), "one");
  storage.setItem(`${PERSISTED_REPORT_STORAGE_PREFIX}another`, "two");
  storage.setItem("ofora-agents:workspace:state", "keep");

  const removed = clearPersistedReports(storage);

  assert.equal(removed, 2);
  assert.equal(storage.getItem(getPersistedReportStorageKey(completedRun.runId)), null);
  assert.equal(storage.getItem("ofora-agents:workspace:state"), "keep");
});

function createStorage() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    }
  };
}

const completedRun: OrchestrationRun = {
  runId: "run-demo-001",
  status: "completed",
  startedAt: "2026-07-12T00:00:00.000Z",
  agents: [
    { name: "PolicyLock", price: "$0.04", status: "delivered", orderId: "policy-order-001", txHash: "0xpay-policy", resultHash: "delivery-policy", providerDeliveryTxHash: "0xprovider-policy", elapsedMs: 100 },
    { name: "BidNormalizer", price: "$0.04", status: "delivered", orderId: "bid-order-001", txHash: "0xpay-bid", resultHash: "delivery-bid", providerDeliveryTxHash: "0xprovider-bid", elapsedMs: 120 },
    { name: "SupplierRisk", price: "$0.04", status: "delivered", orderId: "risk-order-001", txHash: "0xpay-risk", resultHash: "delivery-risk", providerDeliveryTxHash: "0xprovider-risk", elapsedMs: 130 },
    { name: "AwardVerifier", price: "$0.06", status: "delivered", orderId: "award-order-001", txHash: "demo_receipt_award", resultHash: "delivery-award", elapsedMs: 80 },
    { name: "ReceiptWriter", price: "$0.04", status: "delivered", orderId: "receipt-order-001", txHash: "demo_receipt_writer", resultHash: "delivery-receipt", elapsedMs: 70 }
  ],
  outputs: {
    policyLock: {
      agent: "PolicyLock",
      policyIntegrity: "confirmed",
      checks: [{ check: "Criteria weights total 100", status: "passed", summary: "Criteria weights total 100." }],
      disclaimer: "Review required."
    },
    bidNormalizer: {
      agent: "BidNormalizer",
      normalizedSuppliers: [{ supplier: "Nova Relief Systems", bidBand: "within managed value", deliveryBand: "ready", documentCompleteness: "complete", normalizedScore: 94 }],
      withheldFields: ["raw commercial proposal"],
      disclaimer: "Raw commercial proposal fields are withheld."
    },
    supplierRisk: {
      agent: "SupplierRisk",
      riskFlags: [{ supplier: "Nova Relief Systems", severity: "low", issue: "No material risk found.", reviewRequired: false }],
      summary: "No material selected-supplier flags.",
      disclaimer: "Review required."
    },
    awardVerifier: {
      agent: "AwardVerifier",
      awardStatus: "validated",
      selectedSupplier: "Nova Relief Systems",
      validationSummary: "Nova Relief Systems followed the locked evaluation policy.",
      policyMatch: true,
      reviewNotes: ["Procurement officer review remains required."],
      disclaimer: "Review required."
    },
    receiptWriter: {
      agent: "ReceiptWriter",
      receiptId: "far-001",
      tenderId: "OFR-2026-041",
      selectedSupplier: "Nova Relief Systems",
      awardStatus: "validated",
      fairAwardReceiptSummary: "Fair Award Receipt generated for Nova Relief Systems.",
      provenance: [
        { agent: "PolicyLock", outputRef: "policy-integrity-checks" },
        { agent: "BidNormalizer", outputRef: "normalized-supplier-bands" },
        { agent: "SupplierRisk", outputRef: "supplier-risk-flags" },
        { agent: "AwardVerifier", outputRef: "award-validation-summary" },
        { agent: "ReceiptWriter", outputRef: "fair-award-receipt" }
      ],
      disclaimer: "Review required."
    }
  }
};
