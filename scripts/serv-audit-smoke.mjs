import { redactSecrets } from "../server/src/auditEvidence.js";
import { runSmoke } from "../server/src/servSmoke.js";

const report = await runSmoke({
  apiKey: process.env.SERV_API_KEY,
  model: process.env.SERV_MODEL,
  baseUrl: process.env.SERV_BASE_URL,
  maxCompletionTokens: 200,
  timeoutMs: 12_000,
});

const secret = process.env.SERV_API_KEY || "";
const printed = JSON.parse(redactSecrets(JSON.stringify({
  harness: "serv-audit-smoke",
  synthetic: true,
  containmentProof: false,
  calls: report.calls,
  exitCode: report.exitCode,
  audit: {
    status: report.audit.status,
    reason: report.audit.reason,
    liveCall: report.audit.liveCall,
    requestAttempted: report.audit.requestAttempted,
    requestSent: report.audit.requestSent,
    invocation: report.audit.invocation,
    model: report.audit.model,
    finishReason: report.audit.finishReason,
    limitations: report.audit.limitations,
    claims: report.audit.claims,
    missingEvidence: report.audit.missingEvidence,
    runtimeEvidence: report.audit.runtimeEvidence,
    providerStatus: report.audit.providerStatus,
    providerType: report.audit.providerType,
    providerCode: report.audit.providerCode,
    providerParam: report.audit.providerParam,
    providerMessage: report.audit.providerMessage,
  },
})));
if (secret && JSON.stringify(printed).includes(secret)) {
  console.error("Refusing to print a report that contains the API key.");
  process.exit(1);
}
console.log(JSON.stringify(printed, null, 2));
if (report.exitCode !== 0) {
  console.error(`SERV smoke did not pass (${report.audit.status}${report.audit.reason ? `/${report.audit.reason}` : ""}). This is not containment proof.`);
}
process.exit(report.exitCode);
