# ProveRun

ProveRun is a Blast Radius Zero MVP. You ask a question, optionally attach a CSV, and a model writes Python. That Python runs in a disposable Docker sandbox. The real stdout comes back, and the model explains it.

The sandbox is the boundary. It has no network, a memory cap, a time cap, a dropped capability set, and a read-only root. The Vultr API key stays in the API process. It is not mounted into the sandbox and it is not passed as an environment variable.

When `VULTR_INFERENCE_API_KEY` is unset, ProveRun uses a deterministic mock that still emits a real stdlib script. The sample regions file can be analyzed without a Vultr account.

## Vultr deployment

The public demo is a Vultr Cloud Compute VM at `140.82.0.23`. That VM hosts the built web UI and the Express API on port 8787, and Docker on the same VM runs the execution sandbox. Vultr Serverless Inference is separate: it writes the Python (and the short explanation of stdout). The model is not running on the VM.

- Demo: http://140.82.0.23:8787
- Hackathon page: https://lablab.ai/ai-hackathons/vultr-hackathon/peterzhou/proverun

`GET /api/health` reports configuration only. It does not call Serverless Inference and it does not start a container. `inference` is `vultr` when the API process has `VULTR_INFERENCE_API_KEY` set, and `mock` when it does not. `sandbox.runtime`, `sandbox.network`, `sandbox.memory`, and `sandbox.timeoutSec` are the limits that process would pass to `docker run`.

On 7 November 2026 at 11:28 UTC, `GET http://140.82.0.23:8787/api/health` returned HTTP 200 with `inference` `vultr`, sandbox runtime `docker`, network `none`, memory `256m`, and timeout `20` seconds. GETs of the public page assets were checked at the same time. That audit did not submit a question and did not run the containment probe.

## Architecture

```
browser (web/)
  |  POST /api/run   { question, csv }  or  { containment: true }
  v
Express API (server/)
  |  1. Vultr Serverless Inference, OpenAI-compatible
  |     https://api.vultrinference.com/v1/chat/completions
  |     or the local mock when no API key is set
  |  2. docker run --network none --memory … --read-only --cap-drop ALL
  |  3. stdout returns to the model for a short explanation
  v
job record  GET /api/jobs/:id
```

Details and the containment checks are in [ARCHITECTURE.md](ARCHITECTURE.md). On the public VM, Cloud Compute is the web, API, and Docker host; Serverless Inference is only the model call, as described above.

## SERV audit

SERV is an optional audit of sanitized sandbox evidence. It is off unless a run sends `{ "audit": true }` and `SERV_API_KEY` is set. The default buttons do not send that flag. The public Vultr demo is unchanged.

The audit runs only after the sandbox returns. It cannot start a container or change network, mounts, or limits. Runtime records stay separate from model claims. A cited claim is kept only when its numbers and cited scalars occur in that cited text; that is still not execution proof. Stdout and stderr are arbitrary output: redaction is best-effort and does not prove they are secret-free. A missing key, malformed JSON, a schema violation, an unknown or ungrounded evidence id, a refusal, `tool_calls`, `content_filter`, `finish_reason: "length"`, or a provider error ends as `unconfigured` or `inconclusive` with no accepted claims.

Setup, the request contract, and the fixture-only test record are in [docs/SERV-AUDIT.md](docs/SERV-AUDIT.md).

## Containment

Two entry points run the same idea:

- **Try containment test** in the web UI. `POST /api/run` with `{ "containment": true }` starts a fixed probe, not model-written code. The probe tries to open a socket, see a host canary path, read ProveRun host secrets from the environment (not image noise like `GPG_KEY`), and write on the container root. A second container tries to delete its own filesystem. The API then checks that the host canary file is unchanged.
- `scripts/demo-containment.sh` does that from the shell and prints `PASS containment` or `FAIL`.

```bash
docker pull python:3.12-slim
bash scripts/demo-containment.sh
```

The probe source is `scripts/containment_probe.py`.

## Local run

Node 20 or newer and Docker are required for a live sandbox. Tests do not need Docker or a Vultr key.

```bash
npm install
cp .env.example .env
docker pull python:3.12-slim
npm run dev
```

- API: http://127.0.0.1:8787
- UI: http://127.0.0.1:5173 (Vite proxies `/api` to the API)

Open the UI, choose **Use sample regions.csv**, and run the prefilled latency question. With no API key the inference badge stays on `mock`, and the stdout still comes from the Python script.

Production mode serves the built UI from the API:

```bash
npm run build
npm start
```

Tests:

```bash
npm test
```

## Environment

| Variable | Purpose |
| --- | --- |
| `PORT` | API port. Default `8787`. |
| `VULTR_INFERENCE_API_KEY` | Bearer token for Vultr. Empty means mock inference. |
| `VULTR_INFERENCE_BASE_URL` | Default `https://api.vultrinference.com/v1`. |
| `VULTR_INFERENCE_MODEL` | Default `deepseek-v4.1-flash-1017`. |
| `SANDBOX_IMAGE` | Default `python:3.12-slim`. |
| `SANDBOX_TIMEOUT_SEC` | Wall clock cap. Default `20`. |
| `SANDBOX_MEMORY` | Docker `--memory` and `--memory-swap`. Default `256m`. |
| `SANDBOX_CPUS` | Default `0.5`. |
| `SANDBOX_PIDS_LIMIT` | Default `64`. |
| `MAX_CSV_BYTES` | Upload cap. Default `200000`. |
| `SERV_API_KEY` | Optional. Empty disables the audit. No request is sent unless a run opts in. |
| `SERV_BASE_URL` | Default `https://inference-api.openserv.ai/v1`. |
| `SERV_MODEL` | Default `gpt-5.4-mini`, the chat-completions example id on the SERV docs. |
| `SERV_TIMEOUT_MS` | Audit HTTP timeout. Default `12000`. |
| `SERV_MAX_COMPLETION_TOKENS` | Output cap for one audit call. Default `500`. |

See `.env.example`.

## Docker

`docker-compose.yml` builds the API image, publishes port 8787, and mounts the host Docker socket so the API can start sibling sandboxes.

**Docker socket warning.** Mounting `/var/run/docker.sock` into the API container gives that container control of the Docker daemon, which is root-equivalent on the host. A bug or a hostile request that reached the daemon could start privileged containers. Prefer `npm run dev` on the host, where only the API process can talk to Docker and every sandbox is still started with `--network none`, `--cap-drop ALL`, a read-only root, and no secret environment. Do not mount the socket into the sandbox. The compose file mounts it only on the API service.

The sandbox image is pulled by the host daemon (`docker pull python:3.12-slim`). It is not copied into the API image. The API image does include the Docker client binary so compose can call the mounted socket.

## Layout

- `server/` — Express API: `/api/health`, `/api/run`, `/api/jobs`, `/api/jobs/:id`, inference client, `docker run` sandbox
- `web/` — Vite + React UI with the sample CSV flow and the containment button
- `scripts/demo-containment.sh` — host isolation demo
- `examples/regions.csv` — sample regions, prices, and latency

Jobs live in memory and disappear when the API restarts.

## License

MIT. See [LICENSE](LICENSE).
