import { useEffect, useState } from "react";

const SAMPLE_QUESTION = "Which region has the lowest latency, and what is its CPU price?";

export default function App() {
  const [health, setHealth] = useState(null);
  const [question, setQuestion] = useState(SAMPLE_QUESTION);
  const [csv, setCsv] = useState("");
  const [csvName, setCsvName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [job, setJob] = useState(null);
  const [servAudit, setServAudit] = useState(false);

  useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  async function useSample() {
    setError("");
    const response = await fetch("/api/sample/regions.csv");
    if (!response.ok) {
      setError("Could not load the sample CSV.");
      return;
    }
    setCsv(await response.text());
    setCsvName("regions.csv");
    if (!question.trim()) setQuestion(SAMPLE_QUESTION);
  }

  function onFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(String(reader.result || ""));
      setCsvName(file.name);
    };
    reader.readAsText(file);
  }

  async function runAnalysis(event) {
    event.preventDefault();
    await submit({ question, csv });
  }

  async function runContainment() {
    await submit({ containment: true, question });
  }

  async function submit(body) {
    setBusy(true);
    setError("");
    setJob(null);
    const requestBody = servAudit ? { ...body, audit: true } : body;
    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error || "Request failed.");
        return;
      }
      const finished = await poll(payload.job.id);
      setJob(finished);
      if (finished.status === "error" && finished.error) setError(finished.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="mast">
        <p className="eyebrow">Blast Radius Zero</p>
        <h1>ProveRun</h1>
        <p className="lede">
          Ask a question about a CSV. Vultr Serverless Inference writes Python.
          A container with no network and no secrets runs it. You get the real
          stdout, then a short explanation.
        </p>
        <p className="statusline">
          <span>Inference {health ? health.inference : "…"}</span>
          <span>Sandbox network {health?.sandbox?.network || "none"}</span>
          <span>{health?.sandbox?.image || "python:3.12-slim"}</span>
        </p>
      </header>

      <main className="layout">
        <form className="panel" onSubmit={runAnalysis}>
          <label htmlFor="question">Question</label>
          <textarea
            id="question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            rows={4}
            placeholder="Which region is cheapest?"
          />

          <div className="row">
            <label className="file" htmlFor="csv">
              {csvName ? `CSV: ${csvName}` : "Attach a CSV"}
              <input id="csv" type="file" accept=".csv,text/csv" onChange={onFile} />
            </label>
            <button type="button" className="ghost" onClick={useSample} disabled={busy}>
              Use sample regions.csv
            </button>
          </div>
          {csv ? (
            <pre className="preview" aria-label="CSV preview">{csv.slice(0, 500)}</pre>
          ) : (
            <p className="hint">No file yet. The sample lists cloud regions, price, and latency.</p>
          )}

          <label className="checkline">
            <input
              type="checkbox"
              checked={servAudit}
              onChange={(event) => setServAudit(event.target.checked)}
              disabled={busy}
            />
            <span>Opt-in SERV audit of sandbox evidence. Off by default. Unchecked runs do not call SERV.</span>
          </label>
          <div className="actions">
            <button type="submit" disabled={busy || !question.trim()}>
              {busy ? "Running…" : "Run in sandbox"}
            </button>
            <button type="button" className="danger" onClick={runContainment} disabled={busy}>
              Try containment test
            </button>
          </div>
          {error ? <p className="error" role="alert">{error}</p> : null}
        </form>

        <section className="panel results" aria-live="polite">
          <h2>{job?.mode === "containment" ? "Containment" : "Result"}</h2>
          {!job ? <p className="hint">Stdout from the sandbox shows up here. The model only explains after that.</p> : null}
          {job ? <JobView job={job} /> : null}
        </section>
      </main>
    </div>
  );
}

function JobView({ job }) {
  return (
    <div className="job">
      <p className={`pill ${job.status}`}>{job.status}</p>
      {job.checks ? (
        <ul className="checks">
          {job.checks.map((check) => (
            <li key={check.name} className={check.pass ? "pass" : "fail"}>
              <strong>{check.pass ? "Pass" : "Fail"}</strong>
              <span>{check.name}</span>
              <small>{check.detail}</small>
            </li>
          ))}
        </ul>
      ) : null}
      {job.explanation ? (
        <div>
          <h3>Explanation</h3>
          <p className="prose">{job.explanation}</p>
        </div>
      ) : null}
      {job.stdout ? (
        <div>
          <h3>Stdout</h3>
          <pre>{job.stdout}</pre>
        </div>
      ) : null}
      {job.stderr ? (
        <div>
          <h3>Stderr</h3>
          <pre>{job.stderr}</pre>
        </div>
      ) : null}
      {job.code ? (
        <div>
          <h3>Python</h3>
          <pre>{job.code}</pre>
        </div>
      ) : null}
      {job.audit ? <AuditView audit={job.audit} /> : null}
    </div>
  );
}

function AuditView({ audit }) {
  return (
    <div className="audit">
      <h3>SERV audit</h3>
      <p className="note">
        Status {audit.status}{audit.reason ? ` (${audit.reason})` : ""}. Model statements are inferences, not execution proof.
        {audit.liveCall ? " This process called the configured SERV endpoint." : " This result is not a live SERV call."}
      </p>
      <ul className="checks">
        {audit.limitations?.map((item) => (
          <li key={item}><strong>Limit</strong><span>{item}</span></li>
        ))}
      </ul>
      <h3>Runtime evidence</h3>
      {audit.runtimeEvidence?.map((item) => (
        <pre key={item.id}>{`${item.id}\n${item.text}`}</pre>
      ))}
      <h3>Model inferences</h3>
      {audit.claims?.length ? audit.claims.map((claim) => (
        <p key={claim.id} className="prose">
          {claim.statement} ({claim.citation}; refs {claim.evidenceRefs.join(", ") || "none"})
        </p>
      )) : <p className="note">No model claim was accepted.</p>}
      {audit.missingEvidence?.length ? (
        <>
          <h3>Missing evidence</h3>
          <ul className="checks">
            {audit.missingEvidence.map((item) => (
              <li key={item}><strong>Gap</strong><span>{item}</span></li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

async function poll(id) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch(`/api/jobs/${id}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Job disappeared.");
    if (payload.job.status === "done" || payload.job.status === "error") return payload.job;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("The job took too long.");
}
