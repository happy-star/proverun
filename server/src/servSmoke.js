import { buildRuntimeEvidence } from "./auditEvidence.js";
import { createServAuditor } from "./servAudit.js";

export const SYNTHETIC_STDOUT = "SYNTHETIC sample only. marker=synthetic-stdout-token-7. Not a containment run.";

export function syntheticEvidence() {
  return buildRuntimeEvidence({
    mode: "synthetic",
    csvBytes: 0,
    questionChars: 0,
    requested: { network: "none", memory: "256m", timeoutSec: 20 },
    runs: [{
      name: "sandbox",
      exitCode: 0,
      timedOut: false,
      stdout: SYNTHETIC_STDOUT,
      stderr: "",
    }],
  });
}

export async function runSmoke(options = {}) {
  const apiKey = String(options.apiKey || "").trim();
  const evidence = options.evidence || syntheticEvidence();
  let calls = 0;
  if (!apiKey) {
    const auditor = createServAuditor({ servApiKey: "" });
    const audit = await auditor.review(evidence);
    return { exitCode: 2, calls: 0, audit, synthetic: true, containmentProof: false };
  }
  const realFetch = options.fetchImpl || globalThis.fetch;
  const live = !options.fetchImpl;
  const fetchImpl = async (url, init) => {
    calls += 1;
    if (calls > 1) {
      return { ok: false, status: 0, json: async () => ({}) };
    }
    return realFetch(url, init);
  };
  const auditor = createServAuditor({
    servApiKey: apiKey,
    servModel: options.model,
    servBaseUrl: options.baseUrl,
    servTimeoutMs: options.timeoutMs || 12_000,
    servMaxCompletionTokens: options.maxCompletionTokens || 200,
  }, {
    fetchImpl,
    invocation: live ? "serv-http" : "local-fixture",
    allowLiveResult: live,
  });
  const audit = await auditor.review(evidence);
  return { exitCode: smokeExit(audit), calls, audit, synthetic: true, containmentProof: false };
}

export function smokeExit(audit) {
  if (!audit || audit.status === "unconfigured") return 2;
  if (audit.status !== "ok" || audit.liveCall !== true || audit.invocation !== "serv-http") return 1;
  if (!Array.isArray(audit.claims) || audit.claims.length === 0) return 1;
  if (!audit.claims.every((claim) => claim.supported === true && claim.citation === "cited" && claim.authority === "model-inference")) {
    return 1;
  }
  const blob = JSON.stringify(audit.runtimeEvidence || []);
  if (!blob.includes("SYNTHETIC") || !blob.includes("synthetic-stdout-token-7")) return 1;
  return 0;
}
