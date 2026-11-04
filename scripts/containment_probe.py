"""Containment probe. Runs only inside the sandbox.

It reports whether the network is open, whether a host canary path is visible,
whether ProveRun host secrets were injected into the container environment, and
whether the process can write outside the read-only root.

Image-baked noise such as GPG_KEY on python:3.12-slim is ignored. The check
matches what the API sandbox forwards: only PYTHONUNBUFFERED /
PYTHONDONTWRITEBYTECODE, never VULTR_* / OPENAI_* / PROVERUN_* host secrets.
"""

import json
import os
import socket
from pathlib import Path

proof = {
    "network": "unknown",
    "host_canary_visible": None,
    "secret_env_keys": [],
    "wrote_outside_work": None,
}

sock = socket.socket()
sock.settimeout(2)
try:
    sock.connect(("1.1.1.1", 443))
    proof["network"] = "open"
except Exception:
    proof["network"] = "blocked"
finally:
    sock.close()

proof["host_canary_visible"] = Path("/host-canary-proverun").exists()

# Host secrets ProveRun (or the demo script) may hold. Do not treat distro image
# env like GPG_KEY as a leak — the API never injects host secrets into docker run.
HOST_SECRET_PREFIXES = ("VULTR_", "OPENAI_", "PROVERUN_")
HOST_SECRET_NAMES = {
    "API_KEY",
    "OPENAI_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
}


def is_host_secret_key(name: str) -> bool:
    upper = name.upper()
    if upper.startswith(HOST_SECRET_PREFIXES):
        return True
    return upper in HOST_SECRET_NAMES


proof["secret_env_keys"] = sorted(key for key in os.environ if is_host_secret_key(key))

try:
    Path("/proverun-escape").write_text("nope", encoding="utf-8")
    proof["wrote_outside_work"] = True
except Exception:
    proof["wrote_outside_work"] = False

print(json.dumps(proof, sort_keys=True))
