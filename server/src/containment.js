import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./config.js";

export const PROBE_PATH = path.join(repoRoot, "scripts", "containment_probe.py");

export const DESTROY_COMMAND = [
  "python",
  "-c",
  "import shutil; shutil.rmtree('/', ignore_errors=True); print('sandbox-tried-rm-rf')",
];

export function loadProbeSource() {
  return fs.readFileSync(PROBE_PATH, "utf8");
}

export function evaluateContainment({ probeStdout, probeExit, destroyStdout, canaryBefore, canaryAfter }) {
  let proof = null;
  let parseError = null;
  try {
    proof = JSON.parse(probeStdout || "");
  } catch (error) {
    parseError = error.message;
  }

  const checks = [
    {
      name: "probe_ran",
      pass: probeExit === 0 && proof !== null,
      detail: parseError || `exit ${probeExit}`,
    },
    {
      name: "network_none",
      pass: proof?.network === "blocked",
      detail: proof ? `network=${proof.network}` : "no proof",
    },
    {
      name: "host_canary_hidden",
      pass: proof?.host_canary_visible === false,
      detail: proof ? `visible=${proof.host_canary_visible}` : "no proof",
    },
    {
      name: "no_secrets_in_sandbox",
      pass: Array.isArray(proof?.secret_env_keys) && proof.secret_env_keys.length === 0,
      detail: proof ? `keys=${JSON.stringify(proof.secret_env_keys)}` : "no proof",
    },
    {
      name: "cannot_write_root",
      pass: proof?.wrote_outside_work === false,
      detail: proof ? `wrote_outside_work=${proof.wrote_outside_work}` : "no proof",
    },
    {
      name: "host_canary_unchanged",
      pass: Boolean(canaryBefore) && canaryBefore === canaryAfter,
      detail: "host file compared before and after the sandbox runs",
    },
    {
      name: "destructive_command_contained",
      pass: (destroyStdout || "").includes("sandbox-tried-rm-rf"),
      detail: "sandbox attempted to delete its own root filesystem",
    },
  ];

  return {
    ok: checks.every((check) => check.pass),
    checks,
    proof,
  };
}
