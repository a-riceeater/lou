import { useCallback, useEffect, useState } from "react";
import { friendlyError } from "../api/client";

/** Loads data with explicit loading/error states and a reload handle. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await run());
      setError(null);
    } catch (err) {
      setError(friendlyError(err).message);
    } finally {
      setLoading(false);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <div className="empty" role="alert">
      <strong>{message}</strong>
      <button className="btn" style={{ marginLeft: -16 }} onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export function Toggle({ checked, onChange, label, danger }: { checked: boolean; onChange(v: boolean): void; label: string; danger?: boolean }) {
  return <input type="checkbox" role="switch" className={`switch${danger ? " danger" : ""}`} aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />;
}

const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "just now";
  if (abs < 3600) return RTF.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return RTF.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 7) return RTF.format(Math.round(diff / 86400), "day");
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
