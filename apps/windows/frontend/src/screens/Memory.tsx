import { MEMORY_TYPES, type MemoryType, type MemoryView } from "@lou/protocol";
import { useState } from "react";
import { api, friendlyError } from "../api/client";
import { Empty, LoadError, useLoad } from "../components/ui";

const TYPE_LABEL: Record<MemoryType, string> = {
  preference: "Preferences",
  identity: "About you",
  account_mapping: "Accounts",
  contact: "People",
  project: "Projects",
  routine: "Routines",
  notification_rule: "Notifications",
  environment: "Devices and setup",
};

export function Memory() {
  const memories = useLoad(() => api.memories());
  const [text, setText] = useState("");
  const [type, setType] = useState<MemoryType>("preference");
  const [error, setError] = useState<string | null>(null);

  const all = memories.data ?? [];
  const suggested = all.filter((m) => m.status === "proposed");
  const active = all.filter((m) => m.status === "active");

  return (
    <>
      <h1 className="screen-title">Memory</h1>
      <p className="screen-sub">Facts and preferences Lou uses to get things right. Passwords are never stored here.</p>

      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          try {
            await api.addMemory(type, text.trim());
            setText("");
            setError(null);
            void memories.reload();
          } catch (err) {
            setError(friendlyError(err).message);
          }
        }}
      >
        <select className="select" style={{ width: 170 }} aria-label="Kind" value={type} onChange={(e) => setType(e.target.value as MemoryType)}>
          {MEMORY_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <input className="text-input" placeholder="I prefer short, friendly replies" value={text} onChange={(e) => setText(e.target.value)} aria-label="New memory" />
        <button className="btn btn-primary" type="submit">
          Add
        </button>
      </form>
      {error && <p className="error-text">{error}</p>}

      {suggested.length > 0 && (
        <>
          <h2 className="section-title">Suggested by Lou</h2>
          <ul className="list">
            {suggested.map((m) => (
              <MemoryRow key={m.id} m={m} onChange={() => void memories.reload()} suggested />
            ))}
          </ul>
        </>
      )}

      {memories.error ? (
        <LoadError message={memories.error} onRetry={() => void memories.reload()} />
      ) : !memories.loading && active.length === 0 ? (
        <Empty title="Nothing remembered yet">Say “remember that…” to Lou, or add something above.</Empty>
      ) : (
        MEMORY_TYPES.filter((t) => active.some((m) => m.type === t)).map((t) => (
          <section key={t}>
            <h2 className="section-title">{TYPE_LABEL[t]}</h2>
            <ul className="list">
              {active
                .filter((m) => m.type === t)
                .map((m) => (
                  <MemoryRow key={m.id} m={m} onChange={() => void memories.reload()} />
                ))}
            </ul>
          </section>
        ))
      )}
    </>
  );
}

function MemoryRow({ m, onChange, suggested }: { m: MemoryView; onChange(): void; suggested?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(m.content);
  return (
    <li className="row">
      {editing ? (
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            await api.updateMemory(m.id, { content: value }).catch(() => undefined);
            setEditing(false);
            onChange();
          }}
        >
          <input className="text-input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} aria-label="Edit memory" />
        </form>
      ) : (
        <div>
          <div style={{ userSelect: "text" }}>{m.content}</div>
          {m.source === "agent-inferred" && <div className="row-sub">Learned by Lou</div>}
        </div>
      )}
      <div className="row-side">
        {suggested ? (
          <>
            <button className="btn" onClick={async () => (await api.deleteMemory(m.id).catch(() => undefined), onChange())}>
              Discard
            </button>
            <button className="btn btn-primary" onClick={async () => (await api.updateMemory(m.id, { status: "active" }).catch(() => undefined), onChange())}>
              Keep
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => setEditing((v) => !v)}>
              {editing ? "Done" : "Edit"}
            </button>
            <button className="btn btn-danger" onClick={async () => (await api.deleteMemory(m.id).catch(() => undefined), onChange())}>
              Forget
            </button>
          </>
        )}
      </div>
    </li>
  );
}
