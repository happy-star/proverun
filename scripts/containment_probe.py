"""Fixed containment probe. Runs only inside the sandbox.

It reports whether the network is open, whether a host canary path is visible,
whether secret-like environment variables were injected, and whether the
process can write outside the read-only root.
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

needles = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL")
proof["secret_env_keys"] = sorted(
    key for key in os.environ if any(needle in key.upper() for needle in needles)
)

try:
    Path("/proverun-escape").write_text("nope", encoding="utf-8")
    proof["wrote_outside_work"] = True
except Exception:
    proof["wrote_outside_work"] = False

print(json.dumps(proof, sort_keys=True))
