import type { ServerMessage } from "@lou/protocol";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { api } from "../api/client";
import { bridge } from "../bridge/bridge";
import { ApprovalCard } from "../components/ApprovalCard";
import { Presence } from "../components/Presence";
import { useVoice } from "../components/useVoice";
import { usePalette } from "../stores/palette";
import "../styles/palette.css";

const reveal = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: "auto" },
  exit: { opacity: 0, height: 0 },
  transition: { duration: 0.22, ease: [0.2, 0.8, 0.2, 1] as const },
};

/** The Alt+Space surface: ask, watch, review, send — then get out of the way. */
export function Palette() {
  const s = usePalette();
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  // Server push → state machine.
  useEffect(() => bridge().on("server.message", (frame) => usePalette.getState().onServerMessage(frame as ServerMessage)), []);

  // When summoned: focus, and surface any approval waiting from another run/device.
  useEffect(() => {
    const focus = async () => {
      input.current?.focus();
      const st = usePalette.getState();
      if (st.phase === "idle" || st.phase === "success" || st.phase === "failure") {
        if (st.phase !== "idle") st.reset();
        const pending = await api.approvals("pending").catch(() => []);
        if (pending[0]) usePalette.getState().showApproval(pending[0]);
      }
    };
    const offShown = bridge().on("window.shown", () => void focus());
    const offPrefill = bridge().on("palette.prefill", (p) => {
      usePalette.getState().reset();
      usePalette.getState().setText(String((p as { text?: string })?.text ?? ""));
      input.current?.focus();
    });
    void focus();
    return () => {
      offShown();
      offPrefill();
    };
  }, []);

  // Keep the native window hugging the panel so nothing invisible blocks clicks.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      void bridge().request("window.resize", { height: Math.ceil(el.getBoundingClientRect().height) + (bridge().kind === "native" ? 0 : 40) }).catch(() => undefined);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const voice = useVoice(
    useCallback(async (audio: string, mime: string) => {
      usePalette.getState().setListening(false);
      try {
        const { text } = await api.transcribe(audio, mime);
        await usePalette.getState().transcribed(text);
      } catch (err) {
        usePalette.getState().fail(err);
      }
    }, []),
    useCallback((err: unknown) => usePalette.getState().fail(err), []),
  );

  const toggleVoice = () => {
    if (voice.recording) voice.stop();
    else {
      usePalette.getState().setListening(true);
      void voice.start();
    }
  };

  const busy = s.phase === "thinking" || s.phase === "tool" || s.phase === "sending" || s.phase === "transcribing";
  const showInput = !busy && s.phase !== "listening";

  return (
    <div
      className="palette-root"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          if (voice.recording) voice.stop();
          // Hiding never discards work: a pending approval is still there next time.
          void bridge().request("window.hide").catch(() => undefined);
        }
      }}
    >
      <div className="panel" ref={panel} data-phase={s.phase}>
        <form
          className="prompt"
          onSubmit={(e) => {
            e.preventDefault();
            void s.submit();
          }}
        >
          <Presence phase={s.phase} />
          {showInput ? (
            <input
              ref={input}
              autoFocus
              aria-label="Ask Lou"
              placeholder={s.phase === "approval" ? "Ask something else…" : "Ask anything…"}
              value={s.text}
              spellCheck={false}
              onChange={(e) => s.setText(e.target.value)}
            />
          ) : (
            <div className="status-line" aria-live="polite">
              <span className="shimmer">{s.phase === "listening" ? "Listening…" : s.phase === "transcribing" ? "Transcribing…" : `${s.label || "Thinking"}…`}</span>
            </div>
          )}
          {(showInput || s.phase === "listening") && (
            <button type="button" className="btn btn-icon mic" aria-label={voice.recording ? "Stop listening" : "Speak"} aria-pressed={voice.recording} onClick={toggleVoice}>
              <MicIcon />
            </button>
          )}
        </form>

        <AnimatePresence initial={false}>
          {(s.phase === "approval" || s.phase === "sending") && s.approval && (
            <motion.div key={`approval-${s.approval.id}`} {...reveal} style={{ overflow: "hidden" }}>
              <div className="body">
                <ApprovalCard
                  approval={s.approval}
                  draft={s.draft}
                  busy={s.phase === "sending"}
                  error={s.error?.message}
                  onChange={s.setDraft}
                  onApprove={() => void s.approve()}
                  onReject={() => void s.reject()}
                />
              </div>
            </motion.div>
          )}
          {(s.phase === "thinking" || s.phase === "tool") && s.stream && (
            <motion.div key="stream" {...reveal} style={{ overflow: "hidden" }}>
              <div className="body">
                <div className="answer streaming" data-testid="stream" aria-live="polite">
                  {s.stream}
                </div>
              </div>
            </motion.div>
          )}
          {s.phase === "success" && s.message && (
            <motion.div key="answer" {...reveal} style={{ overflow: "hidden" }}>
              <div className="body">
                <div className="answer" data-testid="answer">
                  {s.message}
                </div>
              </div>
            </motion.div>
          )}
          {s.phase === "failure" && s.error && (
            <motion.div key="error" {...reveal} style={{ overflow: "hidden" }}>
              <div className="body" role="alert">
                <div className="error-line">{s.error.message}</div>
                <div className="error-actions">
                  {s.error.fallbackProvider && (
                    <button className="btn btn-primary" type="button" onClick={() => void s.retryWith(s.error!.fallbackProvider!)}>
                      {s.error.fallbackProvider === "openai_api" ? "Try with OpenAI API" : "Try with Codex"}
                    </button>
                  )}
                  {s.error.action === "reconnect" && (
                    <button className="btn" type="button" onClick={() => void bridge().request("window.show", { surface: "app", route: "accounts" })}>
                      Reconnect
                    </button>
                  )}
                  {s.error.action === "settings" && (
                    <button className="btn" type="button" onClick={() => void bridge().request("window.show", { surface: "app", route: "settings" })}>
                      Open settings
                    </button>
                  )}
                  <button className="btn" type="button" onClick={() => s.reset()}>
                    Dismiss
                  </button>
                </div>
                {s.error.detail && <div className="error-detail">{s.error.detail}</div>}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 8a5 5 0 0 0 10 0M8 13v1.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
