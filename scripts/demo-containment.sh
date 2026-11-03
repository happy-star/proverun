#!/usr/bin/env bash
# Prove the sandbox cannot touch the host.
# Flags match server/src/sandbox.js (network none, memory cap, no secrets, read-only root).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${SANDBOX_IMAGE:-python:3.12-slim}"
MEMORY="${SANDBOX_MEMORY:-256m}"
CPUS="${SANDBOX_CPUS:-0.5}"
PIDS="${SANDBOX_PIDS_LIMIT:-64}"
TIMEOUT="${SANDBOX_TIMEOUT_SEC:-20}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required. Install Docker and pull ${IMAGE} before running this demo." >&2
  exit 1
fi

CANARY="$(mktemp)"
WORKDIR="$(mktemp -d)"
cleanup() {
  rm -rf "$WORKDIR"
  rm -f "$CANARY"
}
trap cleanup EXIT

SECRET="proverun-host-canary-$(date +%s)-$$"
printf '%s' "$SECRET" > "$CANARY"
chmod 600 "$CANARY"
chmod 755 "$WORKDIR"
cp "$ROOT/scripts/containment_probe.py" "$WORKDIR/probe.py"
chmod 644 "$WORKDIR/probe.py"

# A secret in the host environment must not be passed into the container.
export VULTR_INFERENCE_API_KEY="demo-secret-should-not-leak"

run_sandboxed() {
  local name="$1"
  shift
  timeout --signal=KILL "${TIMEOUT}s" docker run \
    --rm \
    --name "$name" \
    --network none \
    --memory "$MEMORY" \
    --memory-swap "$MEMORY" \
    --cpus "$CPUS" \
    --pids-limit "$PIDS" \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --user 65534:65534 \
    -v "$WORKDIR:/work:ro" \
    -w /work \
    -e PYTHONUNBUFFERED=1 \
    -e PYTHONDONTWRITEBYTECODE=1 \
    "$IMAGE" \
    "$@"
}

echo "Running containment probe in ${IMAGE} (network none)..."
PROBE_OUT="$(run_sandboxed "proverun-demo-probe-$$" python /work/probe.py)"
echo "$PROBE_OUT"

echo "Running a destructive command inside a second sandbox..."
DESTROY_OUT="$(run_sandboxed "proverun-demo-destroy-$$" python -c "import shutil; shutil.rmtree('/', ignore_errors=True); print('sandbox-tried-rm-rf')")"
echo "$DESTROY_OUT"

AFTER="$(cat "$CANARY")"
python3 - "$PROBE_OUT" "$DESTROY_OUT" "$SECRET" "$AFTER" <<'PY'
import json, sys
proof = json.loads(sys.argv[1])
destroy = sys.argv[2]
before, after = sys.argv[3], sys.argv[4]
problems = []
if proof.get("network") != "blocked":
    problems.append(f"network was {proof.get('network')!r}")
if proof.get("host_canary_visible") is not False:
    problems.append("host canary path was visible inside the sandbox")
if proof.get("secret_env_keys"):
    problems.append(f"secret-like env keys leaked: {proof['secret_env_keys']}")
if proof.get("wrote_outside_work") is not False:
    problems.append("sandbox wrote a file on the container root")
if "sandbox-tried-rm-rf" not in destroy:
    problems.append("destructive command did not report completion")
if before != after:
    problems.append("host canary changed")
if problems:
    print("FAIL")
    for item in problems:
        print(" -", item)
    raise SystemExit(1)
print("PASS containment")
print(" - network blocked")
print(" - host canary hidden and unchanged")
print(" - no secret environment variables inside the sandbox")
print(" - write to container root blocked")
print(" - rm -rf / stayed inside the sandbox and the host file is intact")
PY
