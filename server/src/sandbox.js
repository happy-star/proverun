import { spawn } from "node:child_process";

export function sandboxSpawnEnv(hostEnv = process.env) {
  const env = { PATH: hostEnv.PATH || "/usr/bin:/bin" };
  if (hostEnv.HOME) env.HOME = hostEnv.HOME;
  if (hostEnv.DOCKER_HOST) env.DOCKER_HOST = hostEnv.DOCKER_HOST;
  return env;
}

export function buildDockerArgs({
  image,
  workDir,
  memory,
  cpus,
  pidsLimit,
  name,
  command,
}) {
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "none",
    "--memory",
    memory,
    "--memory-swap",
    memory,
    "--cpus",
    String(cpus),
    "--pids-limit",
    String(pidsLimit),
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--user",
    "65534:65534",
    "-v",
    `${workDir}:/work:ro`,
    "-w",
    "/work",
    "-e",
    "PYTHONUNBUFFERED=1",
    "-e",
    "PYTHONDONTWRITEBYTECODE=1",
    image,
    ...command,
  ];
}

export function createSandbox(config, spawnImpl = spawn) {
  return {
    run(options) {
      return runSandbox({ ...config, ...options }, spawnImpl);
    },
  };
}

export function runSandbox(options, spawnImpl = spawn) {
  const name = options.name || `proverun-${Math.random().toString(16).slice(2, 10)}`;
  const args = buildDockerArgs({
    image: options.image || options.sandboxImage,
    workDir: options.workDir,
    memory: options.memory,
    cpus: options.cpus,
    pidsLimit: options.pidsLimit,
    name,
    command: options.command || ["python", "/work/main.py"],
  });
  const timeoutMs = (options.timeoutSec || 20) * 1000;
  const env = sandboxSpawnEnv(options.hostEnv || process.env);

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const child = spawnImpl("docker", args, {
      env,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });

    if (!child || typeof child.on !== "function") {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: "Sandbox runner did not start.",
        timedOut: false,
        command: ["docker", ...args],
      });
      return;
    }

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout?.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= 100_000) stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 100_000) stderr.push(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      const missing = error.code === "ENOENT";
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: missing
          ? "Docker is not installed or not on PATH. The sandbox cannot run."
          : error.message,
        timedOut: false,
        command: ["docker", ...args],
      });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      timedOut = timedOut || signal === "SIGKILL" || code === null;
      const stderrText = Buffer.concat(stderr).toString("utf8");
      const note = timedOut
        ? `\nSandbox exceeded ${options.timeoutSec || 20}s and was killed.`
        : "";
      if (timedOut) {
        spawnImpl("docker", ["rm", "-f", name], { env, timeout: 10_000 });
      }
      resolve({
        exitCode: timedOut ? 124 : code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: stderrText + note,
        timedOut,
        command: ["docker", ...args],
      });
    });
  });
}
