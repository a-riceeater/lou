import type { ApprovalView, NotificationView, ServerMessage } from "@lou/protocol";
import { useEffect, useState } from "react";
import { api, friendlyError } from "../api/client";
import { bridge } from "../bridge/bridge";
import { ApprovalCard } from "../components/ApprovalCard";
import { Empty, LoadError, relativeTime, useLoad } from "../components/ui";

/** Unified attention feed: things waiting for the user first, then what's worth knowing. */
export function Inbox() {
  const approvals = useLoad(() => api.approvals("pending"));
  const feed = useLoad(() => api.notifications());

  useEffect(
    () =>
      bridge().on("server.message", (f) => {
        const frame = f as ServerMessage;
        if (frame.type === "approval.requested" || frame.type === "approval.resolved") void approvals.reload();
        if (frame.type === "notification.created") void feed.reload();
      }),
    [approvals.reload, feed.reload],
  );

  const pending = approvals.data ?? [];
  const items = feed.data ?? [];

  return (
    <>
      <h1 className="screen-title">Inbox</h1>
      <p className="screen-sub">What needs you, across email, messages and your devices.</p>

      {pending.length > 0 && (
        <>
          <h2 className="section-title">Waiting for you</h2>
          {pending.map((a) => (
            <InlineApproval key={a.id} approval={a} onDone={() => void approvals.reload()} />
          ))}
        </>
      )}

      {feed.error ? (
        <LoadError message={feed.error} onRetry={() => void feed.reload()} />
      ) : items.length === 0 && pending.length === 0 && !feed.loading ? (
        <Empty title="Nothing needs your attention">Important email and messages will show up here.</Empty>
      ) : (
        items.length > 0 && (
          <>
            <h2 className="section-title">Recent</h2>
            <ul className="list">
              {items.map((n) => (
                <NotificationRow key={n.id} n={n} onChange={() => void feed.reload()} />
              ))}
            </ul>
          </>
        )
      )}
    </>
  );
}

function InlineApproval({ approval, onDone }: { approval: ApprovalView; onDone(): void }) {
  const initial = Object.fromEntries(approval.fields.filter((f) => f.editable).map((f) => [f.key, f.value]));
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (decision: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      const edits = Object.fromEntries(Object.entries(draft).filter(([k, v]) => initial[k] !== v));
      await api.resolveApproval(approval.id, decision, approval.actionHash, decision === "approve" ? edits : undefined);
      onDone();
    } catch (err) {
      setError(friendlyError(err).message);
      setBusy(false);
    }
  };

  return (
    <div className="inline-approval">
      <ApprovalCard
        approval={approval}
        draft={draft}
        busy={busy}
        error={error}
        onChange={(k, v) => setDraft((d) => ({ ...d, [k]: v }))}
        onApprove={() => void resolve("approve")}
        onReject={() => void resolve("reject")}
      />
    </div>
  );
}

function NotificationRow({ n, onChange }: { n: NotificationView; onChange(): void }) {
  const reply = n.actions.find((a) => a.kind === "reply");
  return (
    <li className="row">
      <div className="row-lead">
        <span className={`dot${n.status === "unread" ? " on" : ""}`} style={n.status === "unread" ? { background: "var(--iris)" } : undefined} />
        <div>
          <div className="row-title">{n.title}</div>
          <div className="row-sub">{n.body}</div>
        </div>
      </div>
      <div className="row-side">
        <span>{relativeTime(n.createdAt)}</span>
        {reply && (
          <button className="btn" onClick={() => void bridge().request("window.show", { surface: "palette", prefill: reply.value })}>
            Reply
          </button>
        )}
        <button
          className="btn"
          onClick={async () => {
            await api.markNotification(n.id, "dismiss").catch(() => undefined);
            onChange();
          }}
        >
          Dismiss
        </button>
      </div>
    </li>
  );
}
