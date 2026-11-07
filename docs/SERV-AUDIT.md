# SERV audit layer

Draft for the SERV Hackathon 02 Open Track. This file is the setup note and the delta writeup. It is not a submission.

## What changed

ProveRun can ask SERV Reasoning to comment on sanitized sandbox evidence after a run. The Vultr generation path, the containment probe, and the default UI requests stay as they were. The public demo on the Vultr Cloud Compute VM is not part of this change and was not redeployed.

The model does not run code and does not receive a tool that can change Docker. `serv_shadow_agent` is not requested. Claims that pass validation are labeled model inferences. Runtime evidence is the allowlisted bundle ProveRun recorded.

## Contract

`POST https://inference-api.openserv.ai/v1/chat/completions`

Documented in the SERV chat-completions reference and quickstart (fetched for this change):

- Auth: `Authorization: Bearer $SERV_API_KEY`
- A system message is required. Requests without one are rejected.
- `model` is a catalog id. This app defaults to `gpt-5.4-mini`, which the chat-completions page uses as its example and which the models page lists at $1.00 per million input tokens and $6.00 per million output tokens, with a 400K context window. `SERV_MODEL` can select another id from that catalog. The client cannot choose the model.
- `messages`: system plus one user message. The user message is delimited evidence, not instructions.
- `reasoning_effort`: `low` (documented values are `none`, `low`, `medium`, `high`).
- `max_completion_tokens`: app cap, default 500.
- `stream`: false.
- `response_format.type`: `json_schema`, schema name `proverun_audit`. The SERV structured-output note says a schema is not a guarantee, so this app validates again.
- `tools`: only `{ type: "function", function: { name: "serv_prompt_guard" } }`. That tool is the documented prompt-injection guard. It is not the shadow agent.

Documented response fields used here: `choices[0].message.content` and `choices[0].finish_reason` (`stop`, `length`, `content_filter`, `tool_calls`). `length` on HTTP 200 is treated as exhausted. Only `stop` plus schema-valid JSON can yield `status: "ok"`.

Model JSON:

```json
{
  "claims": [{ "id": "c1", "statement": "...", "evidenceRefs": ["sandbox.exitCode"] }],
  "missingEvidence": ["..."],
  "limitations": ["..."]
}
```

Every `evidenceRefs` entry must be an id in the bundle just sent. Unknown ids, extra keys, or bad types discard every claim.

Job field `audit` is present only when the request set `audit` to boolean `true`. Otherwise the job JSON does not include `audit`.

`audit.liveCall` is true only after this process uses its own `fetch` against the configured base URL and validation succeeds. It does not mean the claim is execution proof.

## Tested scope

`npm test` covers this with local files in `server/test/fixtures/serv/`. Each file is marked `fixture: "local-fake-not-live"`. The suite injects `fetch` and blocks the case where a provisioned `SERV_API_KEY` or `VULTR_INFERENCE_API_KEY` is already in the environment. It does not call SERV or Vultr.

| Case | Fixture | Expected |
| --- | --- | --- |
| Success | `success.json` | `status: ok`, claims cited, `liveCall: false`, `invocation: local-fixture` |
| Missing evidence | `missing-evidence.json` | gap listed, empty refs marked `uncited` |
| Ref mismatch | `ref-mismatch.json` | `inconclusive` / `ref_mismatch`, claims dropped |
| Malformed | `malformed.json` | `inconclusive` / `malformed_json` |
| Schema | `schema-invalid.json` | `inconclusive` / `schema_invalid` |
| Exhausted | `exhausted.json` | HTTP 200, `finish_reason: length`, claims dropped |
| Provider error | `error.json` | HTTP 503, `provider_error`, upstream body not copied |
| Injection | `injection.json` | hostile stdout redacted, unknown ref dropped, no shadow agent |
| Unconfigured | no fixture call | `unconfigured`, zero fetches |
| Regression | — | `audit: "true"` does not opt in; health keys unchanged; default run does not call the auditor |

Not tested: a live SERV account, billing, `serv_prompt_guard` behavior on the real gateway, or an end-to-end sandbox on the public VM. Do not read a green fixture run as a live success.

## Setup when a key exists

1. Create a key in the SERV console. Put it only in the server environment as `SERV_API_KEY`. Do not put it in the browser, a fixture, or a log line.
2. Leave the UI checkbox off unless you intend to spend credit. Checking it sends one completion after that sandbox run.
3. Restart the API process. Health output does not reveal whether the key is set.
4. A run without the key stores `unconfigured` and does not open a connection.

The $1 grant was described as available. The additional $5 was not verified. This repo does not know the live balance.

## Cost controls

- No call unless `audit` is boolean `true` and the key is non-empty.
- No call when the sandbox produced no run record.
- One request. No retry loop and no `serv_shadow_agent` (the docs default that tool to 3 extra iterations).
- `reasoning_effort` `low` and `max_completion_tokens` 500. At the published `gpt-5.4-mini` output price, 500 tokens is about $0.003 before input. Input is capped by redacted evidence fields of at most 1,200 characters each.
- HTTP timeout default 12 seconds. The client cannot raise the token cap or pick a model.
- Do not set `SERV_API_KEY` on the public Vultr VM until a live audit is an explicit decision. The submitted demo keeps working with the key unset.

## Limitations

SERV does not witness the sandbox. It sees the text ProveRun chooses to send. `requested.*` ids are spawn arguments, not proof the kernel enforced them. A cited claim can still be a wrong reading of that text. Prompt injection inside stdout is untrusted data; a model that follows it is discarded only when the reply fails validation. A reply that cites a real id and still says something false remains an inference on screen, and ProveRun does not act on it.
