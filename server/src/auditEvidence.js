const MAX_FIELD = 1_200;
const RUN_NAMES = new Set(["sandbox", "probe", "destroy"]);

const SECRET_PATTERNS = [
  /\b(?:SERV_API_KEY|VULTR_INFERENCE_API_KEY|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|AUTHORIZATION)\b\s*[:=]\s*\S+/gi,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

export function redactSecrets(text) {
  let out = String(text ?? "");
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  return out.replace(/\u0000/g, "");
}

export function boundText(text, max = MAX_FIELD) {
  const clean = redactSecrets(text).replaceAll("</evidence>", "< /evidence>");
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
      "canary secret",
      "API keys",
    ],
  };
}
