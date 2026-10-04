import { useState } from "react";
import { api, friendlyError } from "../api/client";
import { Empty, LoadError, Toggle, relativeTime, useLoad } from "../components/ui";

export function Skills() {
  const [selected, setSelected] = useState<string | null>(null);
  const skills = useLoad(() => api.skills());
  const proposals = useLoad(() => api.proposals());

  if (selected) return <SkillDetailView id={selected} onBack={() => setSelected(null)} />;
  const suggestions = (proposals.data ?? []).filter((p) => p.kind !== "MEMORY_PROPOSAL");

  return (
    <>
      <h1 className="screen-title">Skills</h1>
      <p className="screen-sub">Procedures Lou follows for tasks you repeat. Skills never change what Lou is allowed to do.</p>

      {suggestions.length > 0 && (
        <>
          <h2 className="section-title">Suggested</h2>
          <ul className="list">
            {suggestions.map((p) => (
              <li key={p.id} className="row">
                <div>
                  <div className="row-title">{p.title}</div>
                  <div className="row-sub">{p.summary}</div>
                </div>
                <div className="row-side">
                  <button className="btn" onClick={async () => (await api.resolveProposal(p.id, false).catch(() => undefined), void proposals.reload())}>
                    Discard
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={async () => {
                      await api.resolveProposal(p.id, true).catch(() => undefined);
                      void proposals.reload();
                      void skills.reload();
                    }}
                  >
                    Keep
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {skills.error ? (
        <LoadError message={skills.error} onRetry={() => void skills.reload()} />
      ) : !skills.loading && !skills.data?.length ? (
        <Empty title="No skills yet" />
      ) : (
        <>
          <h2 className="section-title">Installed</h2>
          <ul className="list">
            {skills.data?.map((s) => (
              <li key={s.id} className="row clickable" onClick={() => setSelected(s.id)}>
                <div>
                  <div className="row-title">
                    {s.name} {s.origin === "agent" && <span className="tag iris">Learned</span>}
                  </div>
                  <div className="row-sub">{s.description}</div>
                </div>
                <div className="row-side" onClick={(e) => e.stopPropagation()}>
                  <span>v{s.version}</span>
                  <Toggle
                    label={`Enable ${s.name}`}
                    checked={s.enabled}
                    onChange={async (v) => {
                      await api.setSkillEnabled(s.id, v).catch(() => undefined);
                      void skills.reload();
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function SkillDetailView({ id, onBack }: { id: string; onBack(): void }) {
  const skill = useLoad(() => api.skill(id), [id]);
  const [error, setError] = useState<string | null>(null);
  const s = skill.data;
  const body = s?.content.replace(/^---[\s\S]*?---\s*/, "") ?? "";

  return (
    <>
      <button className="btn detail-back" onClick={onBack}>
        ‹ Skills
      </button>
      {s && (
        <>
          <h1 className="screen-title">{s.name}</h1>
          <p className="screen-sub">{s.description}</p>
          <div className="skill-body">{body}</div>
          <h2 className="section-title">Versions</h2>
          <ul className="list">
            {s.versions.map((v) => (
              <li key={v.id} className="row">
                <div>
                  <div className="row-title">
                    Version {v.version} {v.status === "active" && <span className="tag iris">Active</span>}
                    {v.status !== "active" && <span className="tag">{v.status.replace("_", " ")}</span>}
                  </div>
                  <div className="row-sub">
                    {v.reason ?? (v.createdBy === "builtin" ? "Built in" : `By ${v.createdBy}`)} — {relativeTime(v.createdAt)}
                  </div>
                  {v.issues.length > 0 && <div className="row-sub">{v.issues.join("; ")}</div>}
                </div>
                <div className="row-side">
                  {v.status !== "active" && v.status !== "rejected" && (
                    <button
                      className="btn"
                      onClick={async () => {
                        try {
                          await api.rollbackSkill(s.id, v.version);
                          void skill.reload();
                        } catch (err) {
                          setError(friendlyError(err).message);
                        }
                      }}
                    >
                      Use this version
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {error && <p className="error-text">{error}</p>}
        </>
      )}
      {skill.error && <LoadError message={skill.error} onRetry={() => void skill.reload()} />}
    </>
  );
}
