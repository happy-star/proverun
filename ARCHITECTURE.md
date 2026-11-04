# Architecture

ProveRun is a small control plane in front of an isolated code runner. The model proposes Python. The sandbox produces the only numbers the explanation is allowed to trust.

## Request path

1. The React app posts `{ question, csv }` to `POST /api/run`, or `{ containment: true }` for the fixed probe.
2. The API stores a job (`queued`) and returns `202` with the job id. The CSV stays on the server; job responses omit it.
3. The inference client calls Vultr Serverless Inference at `https://api.vultrinference.com/v1/chat/completions` using the OpenAI chat-completions shape (`Authorization: Bearer`, `model`, `messages`). The default model is `deepseek-v4.1-flash-1017`.
4. If `VULTR_INFERENCE_API_KEY` is empty, the client skips the network and returns a stdlib script that prints row counts and numeric min/max rows. The explanation is filled from that stdout locally.
5. The API writes `main.py` and, when present, `data.csv` into a fresh temp directory (`0755` / `0644` so the unprivileged container user can read them).
6. `docker run` starts `python:3.12-slim` as uid `65534` with:
   - `--network none`
   - `--memory` and `--memory-swap` set to the same cap
   - `--cpus` and `--pids-limit`
   - `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`
   - a noexec `/tmp` tmpfs
   - the work directory mounted read-only at `/work`
   - only `PYTHONUNBUFFERED` and `PYTHONDONTWRITEBYTECODE` in the container environment
7. The Docker client itself is spawned with `PATH`, `HOME`, and `DOCKER_HOST` only. The Vultr key is not copied into that environment.
8. Stdout and stderr are capped. On timeout the client is killed and `docker rm -f` removes the named container.
9. A second inference call explains the stdout. The prompt tells the model not to invent numbers. Mock mode quotes the stdout instead.
10. The job becomes `done` or `error`. The UI polls `GET /api/jobs/:id`.

`GET /api/health` reports whether inference is `mock` or `vultr` and repeats the sandbox image, memory, timeout, and network mode. It does not start a container.

## Containment

The containment job does not ask the model for code. It copies `scripts/containment_probe.py` into the work directory and runs it under the same `docker run` flags. A second container runs a destructive Python one-liner (`rm` of the container root, errors ignored) and must print `sandbox-tried-rm-rf`.

The API writes a canary file under the host temp directory, mode `0600`, outside the mount. After both containers exit it compares the bytes.

Checks:

| Check | Pass condition |
| --- | --- |
| `probe_ran` | Probe exit 0 and stdout is JSON |
| `network_none` | Probe reports `network=blocked` |
| `host_canary_hidden` | `/host-canary-proverun` does not exist in the container |
| `no_secrets_in_sandbox` | No ProveRun host secrets in the container (`VULTR_*`, `OPENAI_*`, `PROVERUN_*`, and a small set of common API key names). Image noise such as `GPG_KEY` on `python:3.12-slim` is ignored |
| `cannot_write_root` | Writing `/proverun-escape` raises |
| `host_canary_unchanged` | Host canary bytes match |
| `destructive_command_contained` | Second stdout contains `sandbox-tried-rm-rf` and the canary still matches |

`scripts/demo-containment.sh` performs the same checks from the host and exports a fake `VULTR_INFERENCE_API_KEY` in the parent shell to show it is not forwarded.

Generated analysis code is rejected if it mentions `VULTR_INFERENCE_API_KEY` or exceeds 50 KB. That check is extra. The sandbox still would not have the key.

## Process split

- `web/` is a Vite dev server in development and static files under `web/dist` in production. The API serves those files when the build exists.
- `server/` owns jobs, prompts, the Vultr client, and the Docker runner.
- The sandbox image is not the API image. Compose runs the API and mounts the host engine socket so the API can create siblings. See the socket warning in the README. Sandboxes do not receive that socket.

## What this MVP leaves in memory

Jobs are a `Map` in the API process. Restarting the process drops them. There is no account system, no queue beyond the request, and no retry loop when the script crashes. A crash is stored on the job with stderr so a later pass can send it back to the model.

## Tests

`npm test` runs the server `node --test` suite. It covers fence extraction, mock CSV execution via local Python, the Vultr request shape with a fake `fetch`, Docker argument and environment scrubbing, containment evaluation, and the HTTP routes with a fake sandbox. Those tests do not call Vultr and do not require a Docker daemon.
