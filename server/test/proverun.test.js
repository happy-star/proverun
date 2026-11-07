import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, repoRoot } from "../src/config.js";
import { extractPython, reviewCode } from "../src/extract.js";
import { createInferenceClient, mockWrite, WRITE_SYSTEM } from "../src/inference.js";
import { buildDockerArgs, runSandbox, sandboxSpawnEnv } from "../src/sandbox.js";
import { evaluateContainment } from "../src/containment.js";
import { createApp } from "../src/app.js";
import { createJobStore } from "../src/jobs.js";

test("extracts a python fence and rejects key access", () => {
  assert.equal(extractPython("```python\nprint(1)\n```"), "print(1)\n");
  assert.equal(extractPython("```py\nprint(2)\n```"), "print(2)\n");
  assert.equal(extractPython("no code here"), null);
  assert.match(extractPython("import csv\nprint('x')\n"), /^import csv/);
  assert.ok(reviewCode("import os\nprint(os.environ['VULTR_INFERENCE_API_KEY'])"));
  assert.equal(reviewCode("print('ok')\n"), null);
});

test("mock inference does not call the network and answers the sample CSV", async () => {
  let called = false;
  const client = createInferenceClient(
    loadConfig({ VULTR_INFERENCE_API_KEY: "" }),
    async () => {
      called = true;
      throw new Error("fetch should not run");
    },
  );
  assert.equal(client.mode, "mock");
  const written = await client.writePython({
    question: "Which region has the lowest latency?",
    csv: fs.readFileSync(path.join(repoRoot, "examples", "regions.csv"), "utf8"),
  });
  assert.equal(called, false);
  assert.match(written.code, /csv/);
  assert.doesNotMatch(written.code, /VULTR_INFERENCE_API_KEY/);
  assert.match(WRITE_SYSTEM, /standard library/);
  assert.match(WRITE_SYSTEM, /\/work\/data.csv/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proverun-mock-"));
  const csvPath = path.join(dir, "regions.csv");
  fs.copyFileSync(path.join(repoRoot, "examples", "regions.csv"), csvPath);
  const scriptPath = path.join(dir, "main.py");
  fs.writeFileSync(scriptPath, written.code);
  const stdout = await runPython(scriptPath, csvPath);
  assert.match(stdout, /latency_ms: min=8 /);
  assert.match(stdout, /sgp/);
  fs.rmSync(dir, { recursive: true, force: true });

  const explanation = await client.explain({
    question: "Which region has the lowest latency?",
    stdout,
    stderr: "",
  });
  assert.match(explanation.text, /Mock inference/);
  assert.match(explanation.text, /min=8/);
});

test("vultr client posts to the OpenAI-compatible endpoint without putting the key in the prompt", async () => {
  const key = "vultr-test-key";
  const seen = [];
  const client = createInferenceClient(loadConfig({
    VULTR_INFERENCE_API_KEY: key,
    VULTR_INFERENCE_BASE_URL: "https://api.vultrinference.com/v1",
    VULTR_INFERENCE_MODEL: "deepseek-v4.1-flash-1017",
  }), async (url, init) => {
    seen.push({ url, init });
    const body = JSON.parse(init.body);
    const isExplain = body.messages[1].content.includes("stdout:");
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: isExplain
              ? "Singapore has the lowest latency."
              : "```python\nprint('rows=5')\n```",
          },
        }],
      }),
    };
  });
  assert.equal(client.mode, "vultr");
  const written = await client.writePython({ question: "Count rows", csv: "region,latency_ms\newr,12\n" });
  assert.equal(written.code, "print('rows=5')\n");
  const explained = await client.explain({ question: "Count rows", code: written.code, stdout: "rows=5\n", stderr: "" });
  assert.match(explained.text, /Singapore/);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, "https://api.vultrinference.com/v1/chat/completions");
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${key}`);
  assert.equal(JSON.parse(seen[0].init.body).model, "deepseek-v4.1-flash-1017");
  assert.equal(seen.some((call) => JSON.parse(call.init.body).messages.some((message) => String(message.content).includes(key))), false);
});

test("docker args isolate the sandbox and the client env drops secrets", () => {
  const args = buildDockerArgs({
    image: "python:3.12-slim",
    workDir: "/tmp/proverun-work",
    memory: "256m",
    cpus: "0.5",
    pidsLimit: "64",
    name: "proverun-test",
    command: ["python", "/work/main.py"],
  });
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--cap-drop"));
  assert.equal(args[args.indexOf("--memory") + 1], "256m");
  assert.equal(args[args.indexOf("-v") + 1], "/tmp/proverun-work:/work:ro");
  assert.equal(args.includes("VULTR_INFERENCE_API_KEY"), false);

  const env = sandboxSpawnEnv({
    PATH: "/usr/bin",
    HOME: "/home/runner",
    VULTR_INFERENCE_API_KEY: "super-secret",
    AWS_SECRET_ACCESS_KEY: "nope",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.VULTR_INFERENCE_API_KEY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
});

test("sandbox runner reports a missing docker binary", async () => {
  const result = await runSandbox({
    workDir: "/tmp/does-not-matter",
    image: "python:3.12-slim",
    memory: "128m",
    cpus: "0.5",
    pidsLimit: "32",
    timeoutSec: 5,
    command: ["python", "/work/main.py"],
    hostEnv: { PATH: "/usr/bin:/bin", HOME: "/tmp", VULTR_INFERENCE_API_KEY: "hidden" },
  }, () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => child.emit("error", Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" })));
    return child;
  });
  assert.match(result.stderr, /Docker is not installed/);
  assert.equal(result.exitCode, 1);
});

test("containment evaluation accepts a blocked sandbox and rejects a leak", () => {
  const proof = JSON.stringify({
    network: "blocked",
    host_canary_visible: false,
    secret_env_keys: [],
    wrote_outside_work: false,
  });
  const ok = evaluateContainment({
    probeStdout: proof,
    probeExit: 0,
    destroyStdout: "sandbox-tried-rm-rf\n",
    canaryBefore: "abc",
    canaryAfter: "abc",
  });
  assert.equal(ok.ok, true);
  const leaked = evaluateContainment({
    probeStdout: JSON.stringify({
      network: "open",
      host_canary_visible: true,
      secret_env_keys: ["VULTR_INFERENCE_API_KEY"],
      wrote_outside_work: true,
    }),
    probeExit: 0,
    destroyStdout: "",
    canaryBefore: "abc",
    canaryAfter: "changed",
  });
  assert.equal(leaked.ok, false);
});

test("API runs a mock analysis and a containment job without Vultr", async () => {
  const calls = [];
  const app = createApp({
    config: loadConfig({ VULTR_INFERENCE_API_KEY: "", PORT: "0" }),
    jobs: createJobStore(),
    sandbox: {
      async run(options) {
        calls.push(options.command);
        if (options.command.includes("/work/probe.py")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              network: "blocked",
              host_canary_visible: false,
              secret_env_keys: [],
              wrote_outside_work: false,
            }),
            stderr: "",
          };
        }
        if (options.command.includes("-c")) {
          return { exitCode: 0, stdout: "sandbox-tried-rm-rf\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "rows=8\nlatency_ms: min=8 row={\"region\":\"sgp\"}\n", stderr: "" };
      },
    },
  });
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((res) => res.json());
    assert.equal(health.ok, true);
    assert.equal(health.inference, "mock");
    assert.equal(health.sandbox.network, "none");

    const sample = await fetch(`http://127.0.0.1:${port}/api/sample/regions.csv`).then((res) => res.text());
    assert.match(sample, /^region,location/);

    const missing = await fetch(`http://127.0.0.1:${port}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);

    const started = await fetch(`http://127.0.0.1:${port}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Which region has the lowest latency?", csv: sample }),
    });
    assert.equal(started.status, 202);
    const { job } = await started.json();
    const finished = await pollJob(port, job.id);
    assert.equal(finished.status, "done");
    assert.match(finished.stdout, /latency_ms: min=8/);
    assert.match(finished.code, /csv/);
    assert.match(finished.explanation, /Mock inference/);
    assert.equal(Object.hasOwn(finished, "csv"), false);
    assert.equal(Object.hasOwn(finished, "audit"), false);
    assert.equal(Object.hasOwn(job, "audit"), false);

    const containment = await fetch(`http://127.0.0.1:${port}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ containment: true }),
    });
    const containmentJob = await pollJob(port, (await containment.json()).job.id);
    assert.equal(containmentJob.status, "done");
    assert.equal(Object.hasOwn(containmentJob, "audit"), false);
    assert.equal(containmentJob.checks.every((check) => check.pass), true);
    assert.ok(calls.some((command) => command[0] === "python" && command[1] === "/work/main.py"));
    assert.ok(calls.some((command) => command.includes("/work/probe.py")));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("mock writer keeps a hostile question inside a string literal", async () => {
  const written = mockWrite({
    question: '"); import os\nprint("pwned',
    csv: "",
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proverun-escape-"));
  const scriptPath = path.join(dir, "main.py");
  fs.writeFileSync(scriptPath, written.code);
  await runPythonCompile(scriptPath);
  fs.rmSync(dir, { recursive: true, force: true });
});

function runPythonCompile(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-m", "py_compile", scriptPath], { env: { PATH: process.env.PATH } });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr || `py_compile exited ${code}`));
      else resolve();
    });
  });
}

function runPython(scriptPath, csvPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [scriptPath, csvPath], { env: { PATH: process.env.PATH } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr || `python exited ${code}`));
      else resolve(stdout);
    });
  });
}

async function pollJob(port, id) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const body = await fetch(`http://127.0.0.1:${port}/api/jobs/${id}`).then((res) => res.json());
    if (body.job.status === "done" || body.job.status === "error") return body.job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("job did not finish");
}
