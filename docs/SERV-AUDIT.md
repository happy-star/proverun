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
- `tools`: only `{ type: "function", function: { name: "serv_prompt_guard" } }`, matching the published prompt-guard example. `serv_shadow_agent` is not sent. `tool_choice` is omitted. The chat-completions page lists `"none"` as a legal value, and the SDK parameter map does not. No published example sets `tool_choice` when the only tool is `serv_prompt_guard`, and SERV strips `serv_*` tools before the model.
- The JSON schema sent to SERV uses the same keyword set as the structured-output example: `type`, `properties`, `required`, `additionalProperties`, and string or array types. `minLength`, `maxLength`, and `maxItems` are enforced only in this process after the response arrives.
- `reasoning_effort: "low"` matches the reasoning-effort guide, which uses `gpt-5.4-mini` as the example and says to start at `low`. `max_completion_tokens` is the documented chat token-cap field.

Documented response fields used here: `choices[0].message.content` and `choices[0].finish_reason` (`stop`, `length`, `content_filter`, `tool_calls`). `length` on HTTP 200 is exhausted. `content_filter` and `tool_calls` are inconclusive. A non-empty `message.refusal` is inconclusive and its text is not copied. Only `stop`, no refusal, no tool call, and schema-valid JSON can yield `status: "ok"`.

Model JSON:

```json
{
  "claims": [{ "id": "c1", "statement": "...", "evidenceRefs": ["sandbox.exitCode"] }],
  "missingEvidence": ["..."],
  "limitations": ["..."]
}
```

Every `evidenceRefs` entry must be an id in the bundle just sent. A cited claim is kept only when each number in the sentence occurs as its own number in the cited text, and when the sentence does not contradict a cited scalar (`true`, `false`, or `none`) or announce itself as proof. Unknown ids, extra keys, bad types, or an ungrounded sentence discard every claim. `supported: true` means that literal check passed. It does not mean the sentence is execution proof. Uncited claims stay `supported: false`.

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
| HTTP 400 | `http-400.json` | `requestSent` true, `liveCall` false, allowlisted type/code/param kept, poisoned message dropped |
| Injection | `injection.json` | hostile stdout redacted, unknown ref dropped, no shadow agent |
| Ungrounded | inline | number `9` against stdout `8`, proof wording, or `bridge` against `none` drops every claim |
| HTTP 200 non-stop | inline | fenced JSON, `refusal`, `tool_calls`, and `content_filter` are inconclusive |
| Redaction | inline | labeled secrets and evidence-tag breakouts are removed; an ordinary sentence remains |
| Unconfigured | no fixture call | `unconfigured`, zero fetches |
| Smoke harness | `scripts/serv-audit-smoke.mjs` | no key exits 2; a fixture success is not a live pass (exit 1) |
| Regression | — | `audit: "true"` and `audit: 1` do not opt in; health keys unchanged; default run does not call the auditor |

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
- `reasoning_effort` `low` and `max_completion_tokens` 500 on the app path (about $0.003 of output at the published `gpt-5.4-mini` price, plus a small input). The standalone smoke command uses 200 output tokens (about $0.0012) and sends only the synthetic sample.
- HTTP timeout default 12 seconds. The client cannot raise the token cap or pick a model.
- Do not set `SERV_API_KEY` on the public Vultr VM until a live audit is an explicit decision. The submitted demo keeps working with the key unset.

## Observed controlled smoke

One authorized run of the packed `69e6463` runtime returned HTTP 400 after 9.280 seconds. The process exited 1. The report had `calls` 1, `status` `inconclusive`, `reason` `provider_error`, `liveCall` false, `finishReason` null, and `claims` empty. `providerStatus` was 400. The raw provider body was not saved, so this repo does not record `error.type`, `error.code`, `error.param`, or `error.message` for that run. That is not a diagnosis. `liveCall` false meant the response was not a validated success. It did not mean no request was sent: `calls` was 1.

The request on that build also sent `tool_choice: "none"` and a schema containing `minLength`, `maxLength`, and `maxItems`. Those differ from the published prompt-guard and structured-output examples. Whether they caused the 400 is not established. This change stops sending them and records an allowlisted error summary on the next run. It does not claim the 400 is fixed.

`requestAttempted` means this process called `fetch`. `requestSent` means an HTTP status came back. `liveCall` stays true only after a live-capable response passes validation.

## Standalone live smoke

Do not run this against the public demo, and do not restart or replace the process on port 8787. The command does not listen on a port, does not start Docker, and does not call Vultr. It sends one SERV chat completion about a fixed synthetic sample, or it sends nothing if the key is missing.

```bash
SERV_API_KEY='…' node scripts/serv-audit-smoke.mjs
```

The key is an environment variable, not an argument, and the script refuses to print a report that still contains it. It does not load `.env`. Output cap is 200 tokens. There is no retry and no shadow agent.

The input is not a sandbox result. Its stdout is exactly:

```text
SYNTHETIC sample only. marker=synthetic-stdout-token-7. Not a containment run.
```

Exit code `0` is the only pass. The printed JSON then has `synthetic: true`, `containmentProof: false`, `calls: 1`, `requestSent` true, `audit.status` `ok`, `audit.liveCall` `true`, `audit.invocation` `serv-http`, `audit.finishReason` `stop`, and every claim `supported: true`. The runtime evidence text includes `SYNTHETIC` and `synthetic-stdout-token-7`.

A non-zero exit can still mean one request was sent. Read `calls`, `requestAttempted`, and `requestSent`. `liveCall` is not that signal. On a provider error the report keeps the HTTP status. `providerType` is copied only when it is exactly `invalid_request_error`. `providerParam` is copied only when it is one of the chat-completions parameter names in the SERV docs. `providerCode` and `providerMessage` are always omitted: those fields are free text, and redaction would not make an unlabeled key or evidence quote safe to print. The raw body is not stored. The next useful live check is this same command once. That still does not prove an earlier 400 is fixed until that run is reviewed.

Any other SERV outcome exits `1` and is not a pass: inconclusive grounding, refusal, `tool_calls`, `content_filter`, `finish_reason: "length"`, or a provider error. `claims` is empty in those cases and `liveCall` is false. A missing key exits `2` with `calls: 0`.

If a UI check is wanted later, start this branch on a different port, for example `PORT=8791 npm start`, and leave port 8787 alone.

## Limitations

SERV does not witness the sandbox. It sees text ProveRun chooses to send. `requested.*` ids are spawn arguments, not proof the kernel enforced them. Redaction does not make stdout or stderr secret-free. A cited claim can still misread wording that contains no checked number or scalar. Prompt injection inside stdout is untrusted data. ProveRun does not act on model text.
