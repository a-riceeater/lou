import type { Phase } from "../stores/palette";

const LABELS: Record<Phase, string> = {
  idle: "Ready",
  listening: "Listening",
  transcribing: "Transcribing",
  thinking: "Thinking",
  tool: "Working",
  approval: "Waiting for you",
  sending: "Sending",
  success: "Done",
  failure: "Something went wrong",
};

/** The assistant's state, communicated by shape rather than text (DESKTOP_CLIENT.md §3). */
export function Presence({ phase }: { phase: Phase }) {
  return (
    <div className="presence" data-phase={phase} role="img" aria-label={LABELS[phase]} data-testid="presence">
      <span className="core" />
      <span className="ring" />
      <span className="bars" aria-hidden>
        <i />
        <i />
        <i />
        <i />
      </span>
      <svg className="check" viewBox="0 0 26 26" aria-hidden>
        <path d="M7 13.5l4 4 8-9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <svg className="alert" viewBox="0 0 26 26" aria-hidden>
        <path d="M13 7.5v7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="13" cy="18.5" r="1.3" fill="currentColor" />
      </svg>
    </div>
  );
}
