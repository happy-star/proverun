import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import { loadConfig, repoRoot } from "./config.js";
import { createInferenceClient } from "./inference.js";
import { createSandbox } from "./sandbox.js";
import { createJobStore, executeJob, validateRunInput } from "./jobs.js";

export function createApp(options = {}) {
  const config = options.config ?? loadConfig();
  const inference = options.inference ?? createInferenceClient(config);
  const sandbox = options.sandbox ?? createSandbox(config);
  const jobs = options.jobs ?? createJobStore();
  const runner = options.executeJob ?? executeJob;

  const app = express();
  app.disable("x-powered-by");
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      service: "proverun",
      inference: inference.mode,
      sandbox: {
        runtime: "docker",
        network: "none",
        image: config.sandboxImage,
        memory: config.memory,
        timeoutSec: config.timeoutSec,
      },
    });
  });

  app.get("/api/sample/regions.csv", (_req, res) => {
    const file = path.join(repoRoot, "examples", "regions.csv");
    res.type("text/csv").send(fs.readFileSync(file, "utf8"));
  });

  app.get("/api/jobs", (_req, res) => {
    res.json({ jobs: jobs.list().map(publicJob) });
  });

  app.get("/api/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    res.json({ job: publicJob(job) });
  });

  app.post("/api/run", (req, res) => {
    const parsed = validateRunInput(req.body || {}, config);
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const job = jobs.create({
      mode: parsed.containment ? "containment" : "analysis",
      question: parsed.question,
      inference: inference.mode,
    });
    job.csv = parsed.csv;
    res.status(202).json({ job: publicJob(job) });
    Promise.resolve(runner(job, { jobs, inference, sandbox, config })).catch((error) => {
      jobs.update(job.id, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  const dist = path.join(repoRoot, "web", "dist");
  if (fs.existsSync(path.join(dist, "index.html"))) {
    app.use(express.static(dist));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(dist, "index.html"));
    });
  }

  return app;
}

function publicJob(job) {
  const { csv, ...rest } = job;
  return rest;
}
