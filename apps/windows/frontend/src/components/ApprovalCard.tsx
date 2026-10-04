import type { ApprovalView } from "@lou/protocol";
import { useEffect, useLayoutEffect, useRef } from "react";

interface Props {
  approval: ApprovalView;
  draft: Record<string, string>;
  busy: boolean;
  error?: string | null;
  onChange(key: string, value: string): void;
  onApprove(): void;
  onReject(): void;
}

/** Verb for the confirm button, named after what will actually happen. */
function confirmLabel(kind: string): string {
  if (kind.startsWith("email.") || kind.startsWith("message.")) return "Send";
  return "Approve";
}

/**
 * The approval surface: the generated draft is the editor (DESIGN.md §7). No
 * separate edit mode; recipients are shown but fixed, because changing who
 * receives something would be a different action needing a new approval.
 */
export function ApprovalCard({ approval, draft, busy, error, onChange, onApprove, onReject }: Props) {
  const fixed = approval.fields.filter((f) => !f.editable);
  const editable = approval.fields.filter((f) => f.editable);
  const firstEditable = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  useEffect(() => {
    const el = firstEditable.current;
    if (!el) return;
    el.focus();
    // Caret at the end so the user can keep typing naturally.
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }, [approval.id]);

  const verb = confirmLabel(approval.kind);

  return (
    <div
      className="approval"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !busy) {
          e.preventDefault();
          onApprove();
        }
      }}
    >
      <div className="approval-head">
        <div className="approval-title">{approval.title}</div>
        {approval.account && <div className="approval-account">{approval.account}</div>}
      </div>

      {fixed.length > 0 && (
        <dl className="approval-meta">
          {fixed.map((f) => (
            <FixedField key={f.key} label={f.label} value={f.value} />
          ))}
        </dl>
      )}

      {editable.map((f, i) =>
        f.kind === "longtext" ? (
          <AutoTextarea
            key={f.key}
            ref={i === 0 ? (el: HTMLInputElement | HTMLTextAreaElement | null) => { firstEditable.current = el; } : undefined}
            aria-label={f.label}
            value={draft[f.key] ?? ""}
            disabled={busy}
            onChange={(v) => onChange(f.key, v)}
          />
        ) : (
          <input
            key={f.key}
            ref={i === 0 ? (el: HTMLInputElement | HTMLTextAreaElement | null) => { firstEditable.current = el; } : undefined}
            className="editable"
            aria-label={f.label}
            value={draft[f.key] ?? ""}
            disabled={busy}
            onChange={(e) => onChange(f.key, e.target.value)}
          />
        ),
      )}

      {approval.warnings.map((w) => (
        <div key={w} className="warning">
          {w}
        </div>
      ))}
      {error && (
        <div className="warning" role="alert">
          {error}
        </div>
      )}

      <div className="approval-actions">
        <span className="hint">
          <kbd>Ctrl</kbd> <kbd>Enter</kbd> to {verb.toLowerCase()}
        </span>
        <button type="button" className="btn" onClick={onReject} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={onApprove} disabled={busy}>
          {busy ? `${verb === "Send" ? "Sending" : "Approving"}…` : verb}
        </button>
      </div>
    </div>
  );
}

function FixedField({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </>
  );
}

interface AutoTextareaProps {
  value: string;
  disabled?: boolean;
  onChange(value: string): void;
  "aria-label": string;
  ref?: (el: HTMLTextAreaElement | null) => void;
}

function AutoTextarea({ value, disabled, onChange, ref, ...rest }: AutoTextareaProps) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 300)}px`;
  }, [value]);
  return (
    <textarea
      {...rest}
      ref={(el) => {
        inner.current = el;
        ref?.(el);
      }}
      className="editable"
      rows={2}
      value={value}
      disabled={disabled}
      spellCheck
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
