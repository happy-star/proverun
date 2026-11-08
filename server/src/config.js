import path from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(srcDir, "../..");

export function loadConfig(env = process.env) {
  const timeoutSec = positiveInt(env.SANDBOX_TIMEOUT_SEC, 20);
  const maxCsvBytes = positiveInt(env.MAX_CSV_BYTES, 200_000);
  const apiKey = (env.VULTR_INFERENCE_API_KEY || "").trim();
  return {
    port: positiveInt(env.PORT, 8787),
    apiKey,
    inferenceMode: apiKey ? "vultr" : "mock",
    baseUrl: (env.VULTR_INFERENCE_BASE_URL || "https://api.vultrinference.com/v1").replace(/\/$/, ""),
    model: (env.VULTR_INFERENCE_MODEL || "deepseek-v4.1-flash-1017").trim(),
    sandboxImage: env.SANDBOX_IMAGE || "python:3.12-slim",
    timeoutSec,
    memory: env.SANDBOX_MEMORY || "256m",
    cpus: env.SANDBOX_CPUS || "0.5",
    pidsLimit: String(positiveInt(env.SANDBOX_PIDS_LIMIT, 64)),
    maxCsvBytes,
    servApiKey: (env.SERV_API_KEY || "").trim(),
    servBaseUrl: (env.SERV_BASE_URL || "https://inference-api.openserv.ai/v1").replace(/\/$/, ""),
    servModel: (env.SERV_MODEL || "gpt-5.4-mini").trim(),
    servTimeoutMs: positiveInt(env.SERV_TIMEOUT_MS, 12_000),
    servMaxCompletionTokens: positiveInt(env.SERV_MAX_COMPLETION_TOKENS, 500),
    repoRoot,
  };
}

function positiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
