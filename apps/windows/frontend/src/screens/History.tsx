import type { HistoryItem, ServerMessage } from "@lou/protocol";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { bridge } from "../bridge/bridge";
import { Empty, LoadError, relativeTime, useLoad } from "../components/ui";

const OUTCOME: Record<HistoryItem["outcome"], string> = {
  action_taken: "Done",
  answered: "Answered",
  cancelled: "Cancelled",
  failed: "Failed",
  pending: "In progress",
};

export function History() {
  const [selected, setSelected] = useState<string | null>(null);
  const history = useLoad(() => api.history());

  useEffect(
    () =>
      bridge().on("server.message", (f) => {
        if ((f as ServerMessage).type === "agent.completed") void history.reload();
      }),
    [history.reload],
  );

  if (selected) return <RunDetail runId={selected} onBack={() => setSelected(null)} />;

  return (
    <>
      <h1 className="screen-title">History</h1>
      <p className="screen-sub">Everything you've asked, and what happened.</p>
      {history.error ? (
        <LoadError message={history.error} onRetry={() => void history.reload()} />
      ) : !history.loading && !history.data?.length ? (
        <Empty title="No history yet">Press Alt + Space and ask for something.</Empty>
      ) : (
        <ul className="list">
          {history.data?.map((h) => (
            <li key={h.runId} className="row clickable" onClick={() => setSelected(h.runId)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setSelected(h.runId)}>
              <div className="row-lead">
                <span className={`outcome ${h.outcome}`} title={OUTCOME[h.outcome]} />
                <div>
                  <div className="row-title">{h.request}</div>
                  {h.summary && <div className="row-sub">{h.summary}</div>}
                </div>
              </div>
              <div className="row-side">{relativeTime(h.createdAt)}</div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function RunDetail({ runId, onBack }: { runId: string; onBack(): void }) {
  const run = useLoad(() => api.run(runId), [runId]);
  const audit = useLoad(() => api.audit(runId), [runId]);
  const r = run.data;

  return (
    <>
      <button className="btn detail-back" onClick={onBack}>
        ‹ History
      </button>
      {run.error && <LoadError message={run.error} onRetry={() => void run.reload()} />}
      {r && (
        <>
          <h1 className="screen-title">{r.request}</h1>
          <p className="screen-sub">
            {new Date(r.createdAt).toLocaleString()}
            {r.skills.length > 0 && ` — used ${r.skills.join(", ")}`}
          </p>
          {r.finalMessage && <p style={{ fontSize: 15, lineHeight: "23px", userSelect: "text" }}>{r.finalMessage}</p>}
          {r.error && <p className="error-text">{r.error.message}</p>}

          {r.steps.length > 0 && (
            <>
              <h2 className="section-title">Steps</h2>
              <ol className="steps">
                {r.steps.map((s) => (
                  <li key={s.id} className={s.status}>
                    {s.status === "awaiting_approval" ? `${s.label} — asked for your approval` : s.status === "denied" ? `${s.label} — not allowed` : s.label}
                  </li>
                ))}
              </ol>
            </>
          )}

          <details className="dev">
            <summary>Activity log</summary>
            <div className="audit">
              {audit.data?.map((e) => (
                <FragmentRow key={e.id} time={new Date(e.createdAt).toLocaleTimeString()} text={`${e.action}${e.targetId ? ` ${e.targetId}` : ""}`} />
              ))}
            </div>
          </details>
        </>
      )}
    </>
  );
}

function FragmentRow({ time, text }: { time: string; text: string }) {
  return (
    <>
      <span>{time}</span>
      <span>{text}</span>
    </>
  );
}
