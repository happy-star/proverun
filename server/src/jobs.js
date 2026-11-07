import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { reviewCode } from "./extract.js";
import { DESTROY_COMMAND, evaluateContainment, loadProbeSource } from "./containment.js";
import { buildRuntimeEvidence } from "./auditEvidence.js";
import { missingRuntimeAudit, providerFailureAudit, unconfiguredAudit } from "./servAudit.js";

const MAX_QUESTION = 4_000;

export function createJobStore() {
  const jobs = new Map();
  return {
    create(input) {
      const now = new Date().toISOString();
      const job = {
        id: randomUUID(),
        status: "queued",
        mode: input.mode,
        question: input.question || "",
        inference: input.inference,
        code: null,
        stdout: "",
        stderr: "",
        explanation: "",
        checks: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      jobs.set(job.id, job);
      return job;
    },
    get(id) {
      return jobs.get(id) || null;
    },
    list() {
      return [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },
    update(id, patch) {
      const current = jobs.get(id);
      if (!current) return null;
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      jobs.set(id, next);
      return next;
    },
  };
}

export function validateRunInput(body, config) {
  const containment = Boolean(body?.containment);
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  const csv = typeof body?.csv === "string" ? body.csv : "";
  if (!containment && !question) {
    return { error: "A question is required." };
  }
  if (question.length > MAX_QUESTION) {
    return { error: `Question is longer than ${MAX_QUESTION} characters.` };
  }
  if (Buffer.byteLength(csv, "utf8") > config.maxCsvBytes) {
    return { error: `CSV is larger than ${config.maxCsvBytes} bytes.` };
  }
  if (csv.includes("\0")) {
    return { error: "CSV must be text." };
  }
  return { containment, question, csv, audit: body?.audit === true };
}

export async function executeJob(job, deps) {
  const { jobs, inference, sandbox, config } = deps;
  jobs.update(job.id, { status: "running" });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "proverun-"));
  const canaryPath = path.join(os.tmpdir(), `proverun-canary-${job.id}`);
  const canary = `proverun-host-canary-${job.id}`;
  try {
    fs.chmodSync(workDir, 0o755);
    if (job.mode === "containment") {
      await runContainment({ job, jobs, sandbox, config, workDir, canaryPath, canary, serv: deps.serv });
      return;
    }
    await runAnalysis({ job, jobs, inference, sandbox, config, workDir, serv: deps.serv });
  } catch (error) {
    const patch = {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
    const audit = await maybeAudit(job, deps.serv, null);
    if (audit) patch.audit = audit;
    jobs.update(job.id, patch);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(canaryPath, { force: true });
  }
}

async function runAnalysis({ job, jobs, inference, sandbox, config, workDir, serv }) {
  const csvPath = path.join(workDir, "data.csv");
  if (job.csv) fs.writeFileSync(csvPath, job.csv, { mode: 0o644 });
  const written = await inference.writePython({ question: job.question, csv: job.csv });
  const rejection = reviewCode(written.code);
  if (rejection) {
    const patch = { status: "error", error: rejection, code: written.code || written.raw || "" };
    const audit = await maybeAudit(job, serv, null);
    if (audit) patch.audit = audit;
    jobs.update(job.id, patch);
    return;
  }
  const scriptPath = path.join(workDir, "main.py");
  fs.writeFileSync(scriptPath, written.code, { mode: 0o644 });
  const result = await sandbox.run({
    workDir,
    name: containerName(job.id, "run"),
    image: config.sandboxImage,
    memory: config.memory,
    cpus: config.cpus,
    pidsLimit: config.pidsLimit,
    timeoutSec: config.timeoutSec,
    command: ["python", "/work/main.py"],
  });
  let explanation = "";
  try {
    const explained = await inference.explain({
      question: job.question,
      code: written.code,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    explanation = explained.text;
  } catch (error) {
    explanation = `The script ran, but the explanation call failed: ${error.message}`;
  }
  const failed = result.exitCode !== 0;
  const patch = {
    status: failed ? "error" : "done",
    code: written.code,
    stdout: result.stdout,
    stderr: result.stderr,
    explanation,
    error: failed ? `Sandbox exited ${result.exitCode}.` : null,
  };
  const audit = await maybeAudit(job, serv, {
    mode: "analysis",
    csvBytes: Buffer.byteLength(job.csv || "", "utf8"),
    questionChars: (job.question || "").length,
    requested: requestedSandbox(config),
    runs: [namedRun("sandbox", result)],
    checks: null,
  });
  if (audit) patch.audit = audit;
  jobs.update(job.id, patch);
}

async function runContainment({ job, jobs, sandbox, config, workDir, canaryPath, canary, serv }) {
  fs.writeFileSync(canaryPath, canary, { mode: 0o600 });
  fs.writeFileSync(path.join(workDir, "probe.py"), loadProbeSource(), { mode: 0o644 });
  const probe = await sandbox.run({
    workDir,
    name: containerName(job.id, "probe"),
    image: config.sandboxImage,
    memory: config.memory,
    cpus: config.cpus,
    pidsLimit: config.pidsLimit,
    timeoutSec: config.timeoutSec,
    command: ["python", "/work/probe.py"],
  });
  const destroy = await sandbox.run({
    workDir,
    name: containerName(job.id, "destroy"),
    image: config.sandboxImage,
    memory: config.memory,
    cpus: config.cpus,
    pidsLimit: config.pidsLimit,
    timeoutSec: config.timeoutSec,
    command: DESTROY_COMMAND,
  });
  const canaryAfter = fs.readFileSync(canaryPath, "utf8");
  const report = evaluateContainment({
    probeStdout: probe.stdout,
    probeExit: probe.exitCode,
    destroyStdout: destroy.stdout,
    canaryBefore: canary,
    canaryAfter,
  });
  const stderr = [probe.stderr, destroy.stderr].filter(Boolean).join("\n");
  const patch = {
    status: report.ok ? "done" : "error",
    code: loadProbeSource(),
    stdout: [probe.stdout, destroy.stdout].filter(Boolean).join("\n"),
    stderr,
    checks: report.checks,
    explanation: report.ok
      ? "Containment held. The sandbox could not reach the network, see the host canary, read secrets, or change the host after trying to delete its own filesystem."
      : "Containment check failed. Read the checks and stderr. Docker must be running and the sandbox image must be available.",
    error: report.ok ? null : "One or more containment checks failed.",
  };
  const audit = await maybeAudit(job, serv, {
    mode: "containment",
    csvBytes: 0,
    questionChars: (job.question || "").length,
    requested: requestedSandbox(config),
    runs: [namedRun("probe", probe), namedRun("destroy", destroy)],
    checks: report.checks,
  });
  if (audit) patch.audit = audit;
  jobs.update(job.id, patch);
}

function containerName(id, suffix) {
  return `proverun-${suffix}-${id.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`;
}

function namedRun(name, result) {
  return {
    name,
    exitCode: result?.exitCode,
    timedOut: Boolean(result?.timedOut),
    stdout: result?.stdout || "",
    stderr: result?.stderr || "",
  };
}

function requestedSandbox(config) {
  return {
    network: "none",
    memory: config?.memory || "",
    timeoutSec: config?.timeoutSec,
  };
}

async function maybeAudit(job, serv, runtime) {
  if (job.auditRequested !== true) return null;
  if (!runtime) return missingRuntimeAudit();
  const evidence = buildRuntimeEvidence(runtime);
  if (!serv?.configured) return unconfiguredAudit(evidence);
  try {
    return await serv.review(evidence);
  } catch {
    return providerFailureAudit(evidence);
  }
}
