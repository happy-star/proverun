const MAX_FIELD = 1_200;
const RUN_NAMES = new Set(["sandbox", "probe", "destroy"]);

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{10,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:SERV_API_KEY|VULTR_INFERENCE_API_KEY|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|api[_-]?key|secret|token|password|passwd|credential|authorization)\b\s*[:=]\s*(?:"[^"\n]{0,200}"|'[^'\n]{0,200}'|\S+)/gi,
  /([?&](?:key|token|secret|password|access_token)=)[^&\s]+/gi,
];

export function redactSecrets(text) {
  let out = String(text ?? "").replace(/\u0000/g, "");
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags), "[redacted]");
  }
  return out;
}

export function neutralizeEvidenceTags(text) {
  return String(text ?? "")
    .replace(/<\/?\s*evidence\b[^>\n]*>/gi, "[redacted-tag]")
    .replace(/<\s*\/\s*evidence\b/gi, "[redacted-tag]");
}

export function boundText(text, max = MAX_FIELD) {
  const clean = neutralizeEvidenceTags(redactSecrets(text));
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}\n[truncated]`;
}

export function buildRuntimeEvidence(input) {
  const items = [];
  const push = (id, text) => {
    const value = boundText(text);
    items.push({ id, text: value, bytes: Buffer.byteLength(value) });
  };
  const requested = input?.requested || {};
  push("requested.network", requested.network || "none");
  push("requested.memory", requested.memory || "");
  push("requested.timeoutSec", String(requested.timeoutSec ?? ""));
  push("requested.readOnly", "true");
  push("requested.capDrop", "ALL");
  push("meta.mode", input?.mode || "");
  push("meta.csvBytes", String(input?.csvBytes || 0));
  push("meta.questionChars", String(input?.questionChars || 0));

  for (const run of input?.runs || []) {
    if (!RUN_NAMES.has(run?.name)) continue;
    push(`${run.name}.exitCode`, String(run.exitCode));
    push(`${run.name}.timedOut`, String(Boolean(run.timedOut)));
    push(`${run.name}.stdout`, run.stdout || "");
    push(`${run.name}.stderr`, run.stderr || "");
  }
  if (Array.isArray(input?.checks)) {
    const slim = input.checks.map((check) => ({
      name: String(check.name || ""),
      pass: Boolean(check.pass),
    }));
    push("containment.checks", JSON.stringify(slim));
  }

  return {
    items,
    ids: items.map((item) => item.id),
    omitted: [
      "question text",
      "csv contents",
      "generated source",
      "host paths",
      "canary value",
    ],
    redaction: "best-effort patterns only; stdout and stderr are arbitrary output and are not proven secret-free",
  };
}
