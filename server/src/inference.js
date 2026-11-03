import { extractPython, messageText } from "./extract.js";

const WRITE_SYSTEM = [
  "You write one Python 3 script and nothing else.",
  "Use only the standard library. Do not import pandas, requests, or anything that needs pip.",
  "If a CSV is attached, it is mounted at /work/data.csv. Read it with the csv module.",
  "The script may also accept the CSV path as sys.argv[1]; otherwise use /work/data.csv.",
  "Print a concise answer to stdout. Do not open sockets, do not read environment variables, and do not look for API keys.",
  "Return exactly one fenced python block.",
].join(" ");

const EXPLAIN_SYSTEM = [
  "You explain a sandboxed Python run to the person who asked the question.",
  "Use only numbers and facts that appear in the stdout or stderr.",
  "If the run failed, say what failed. Do not invent results.",
  "Keep it to a short paragraph.",
].join(" ");

export function createInferenceClient(config, fetchImpl = globalThis.fetch) {
  const mode = config.inferenceMode;
  return {
    mode,
    writePython(input) {
      if (mode === "mock") return Promise.resolve(mockWrite(input));
      return vultrWrite(config, fetchImpl, input);
    },
    explain(input) {
      if (mode === "mock") return Promise.resolve(mockExplain(input));
      return vultrExplain(config, fetchImpl, input);
    },
  };
}

export function mockWrite({ question, csv }) {
  const q = JSON.stringify(question || "");
  const code = `import csv, json, sys
from pathlib import Path

question = ${q}
path = Path(sys.argv[1] if len(sys.argv) > 1 else "/work/data.csv")
print("question=" + question)
if not path.exists():
    print("no_csv=1")
    raise SystemExit(0)
with path.open(newline="", encoding="utf-8") as handle:
    rows = list(csv.DictReader(handle))
print("rows=" + str(len(rows)))
if not rows:
    raise SystemExit(0)
columns = list(rows[0].keys())
print("columns=" + ",".join(columns))
for column in columns:
    parsed = []
    numeric = True
    for row in rows:
        raw = (row.get(column) or "").strip()
        try:
            parsed.append((float(raw), row))
        except ValueError:
            numeric = False
            break
    if numeric and parsed:
        low = min(parsed, key=lambda item: item[0])
        high = max(parsed, key=lambda item: item[0])
        print(column + ": min=" + format(low[0], "g") + " row=" + json.dumps(low[1], ensure_ascii=False))
        print(column + ": max=" + format(high[0], "g") + " row=" + json.dumps(high[1], ensure_ascii=False))
`;
  return { code, raw: "```python\n" + code + "```", mocked: true };
}

export function mockExplain({ question, stdout, stderr }) {
  const body = (stdout || "").trim() || "(empty stdout)";
  const err = (stderr || "").trim();
  const lines = [
    `Mock inference is on because VULTR_INFERENCE_API_KEY is unset. The sandbox stdout below is the evidence for: ${question || "the request"}.`,
    "Numeric min and max lines are copied from that stdout. Use the column the question asks about.",
    body,
  ];
  if (err) lines.push("stderr: " + err.slice(0, 2000));
  return { text: lines.join("\n"), mocked: true };
}

async function vultrWrite(config, fetchImpl, input) {
  const sample = csvSample(input.csv);
  const user = [
    `Question: ${input.question}`,
    sample ? `CSV sample (the full file is at /work/data.csv):\n${sample}` : "No CSV was attached.",
  ].join("\n\n");
  const raw = await chat(config, fetchImpl, WRITE_SYSTEM, user);
  const code = extractPython(raw);
  return { code, raw, mocked: false };
}

async function vultrExplain(config, fetchImpl, input) {
  const user = [
    `Question: ${input.question || ""}`,
    "Python that ran:",
    input.code || "(none)",
    "stdout:",
    clip(input.stdout, 12_000) || "(empty)",
    "stderr:",
    clip(input.stderr, 4_000) || "(empty)",
  ].join("\n");
  const text = await chat(config, fetchImpl, EXPLAIN_SYSTEM, user);
  return { text, mocked: false };
}

async function chat(config, fetchImpl, system, user) {
  const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.1,
      max_completion_tokens: 1800,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || response.statusText;
    throw new Error(`Vultr inference failed (${response.status}): ${detail}`);
  }
  const text = messageText(payload?.choices?.[0]?.message?.content);
  if (!text.trim()) throw new Error("Vultr inference returned an empty message.");
  return text;
}

function csvSample(csv) {
  if (!csv) return "";
  const lines = csv.split(/\r?\n/).slice(0, 4);
  return lines.join("\n").slice(0, 2000);
}

function clip(value, max) {
  const text = value || "";
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n…[truncated]";
}

export { WRITE_SYSTEM, EXPLAIN_SYSTEM };
