import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBridge } from "../bridge/bridge";
import { Palette } from "../screens/Palette";
import { usePalette } from "../stores/palette";
import { sampleApproval, TestBridge } from "./testBridge";

let bridge: TestBridge;

beforeEach(() => {
  bridge = new TestBridge()
    .route("GET /api/approvals", () => ({ items: [] }))
    .route("POST /api/runs", () => ({ status: 202, body: { runId: "run_1", conversationId: "conv_1" } }))
    .route("GET /api/runs/run_1", () => ({ id: "run_1", status: "reasoning", approvalId: null }))
    .route("POST /api/approvals/apr_1/resolve", (body) => ({ ...sampleApproval(), status: body.decision === "approve" ? "approved" : "rejected" }));
  setBridge(bridge);
  usePalette.getState().reset();
});

afterEach(() => usePalette.getState().reset());

const presence = () => screen.getByTestId("presence").getAttribute("data-phase");

async function askAndReachApproval(user: ReturnType<typeof userEvent.setup>) {
  render(<Palette />);
  await user.type(screen.getByLabelText("Ask Lou"), "Reply to the latest email from Sarah and tell her I'll be there around 6.{Enter}");
  await waitFor(() => expect(presence()).toBe("thinking"));
  act(() => bridge.server("agent.progress", { runId: "run_1", status: "waiting_for_tool", label: "Searching email" }));
  expect(presence()).toBe("tool");
  expect(screen.getByText("Searching email…")).toBeInTheDocument();
  act(() => bridge.server("approval.requested", { approval: sampleApproval() }));
  await waitFor(() => expect(presence()).toBe("approval"));
}

describe("assistant palette", () => {
  it("starts idle with a focused input", () => {
    render(<Palette />);
    expect(presence()).toBe("idle");
    expect(screen.getByLabelText("Ask Lou")).toHaveFocus();
  });

  it("walks through thinking → tool → approval with recipients fixed and the body editable", async () => {
    const user = userEvent.setup();
    await askAndReachApproval(user);
    expect(bridge.apiCalls("/api/runs")[0].body.text).toMatch(/Reply to the latest email from Sarah/);
    expect(screen.getByText("Reply to Sarah")).toBeInTheDocument();
    expect(screen.getByText("sarah@example.com")).toBeInTheDocument();
    expect(screen.getByText("Re: Dinner tonight")).toBeInTheDocument();
    const body = screen.getByLabelText("Message");
    expect(body.tagName).toBe("TEXTAREA");
    expect(body).toHaveValue("Sounds good. I'll be there around 6.");
    expect(screen.queryByLabelText("To")).not.toBeInTheDocument();
  });

  it("sends exactly the edited text", async () => {
    const user = userEvent.setup();
    await askAndReachApproval(user);
    const body = screen.getByLabelText("Message");
    await user.clear(body);
    await user.type(body, "Sounds good! See you around 6:15.");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const resolve = bridge.apiCalls("/api/approvals/apr_1/resolve")[0];
    expect(resolve.body).toEqual({ decision: "approve", actionHash: "a".repeat(64), edits: { body: "Sounds good! See you around 6:15." } });
    expect(presence()).toBe("sending");

    act(() => bridge.server("agent.completed", { runId: "run_1", status: "completed", message: "Sent your reply to Sarah.", error: null }));
    await waitFor(() => expect(presence()).toBe("success"));
    expect(screen.getByTestId("answer")).toHaveTextContent("Sent your reply to Sarah.");
  });

  it("sends unedited drafts without an edits payload, via Ctrl+Enter", async () => {
    const user = userEvent.setup();
    await askAndReachApproval(user);
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(bridge.apiCalls("/api/approvals/apr_1/resolve")[0].body).toEqual({ decision: "approve", actionHash: "a".repeat(64) });
  });

  it("cancel rejects the approval and returns to idle", async () => {
    const user = userEvent.setup();
    await askAndReachApproval(user);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(bridge.apiCalls("/api/approvals/apr_1/resolve")[0].body).toMatchObject({ decision: "reject" });
    await waitFor(() => expect(presence()).toBe("idle"));
    expect(bridge.calls.some((c) => c.method === "window.hide")).toBe(true);
  });

  it("keeps the draft when sending fails", async () => {
    const user = userEvent.setup();
    bridge.route("POST /api/approvals/apr_1/resolve", () => ({ status: 409, body: { error: { code: "APPROVAL_MISMATCH", message: "The request changed since it was shown. Review it again." } } }));
    await askAndReachApproval(user);
    await user.type(screen.getByLabelText("Message"), " Thanks!");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(presence()).toBe("approval"));
    expect(screen.getByRole("alert")).toHaveTextContent("Review it again");
    expect(screen.getByLabelText("Message")).toHaveValue("Sounds good. I'll be there around 6. Thanks!");
  });

  it("shows actionable failures", async () => {
    const user = userEvent.setup();
    render(<Palette />);
    await user.type(screen.getByLabelText("Ask Lou"), "check my email{Enter}");
    act(() => bridge.server("agent.completed", { runId: "run_1", status: "failed", message: null, error: { code: "AUTH_REQUIRED", message: "Gmail needs you to sign in again." } }));
    await waitFor(() => expect(presence()).toBe("failure"));
    expect(screen.getByRole("alert")).toHaveTextContent("Gmail needs you to sign in again.");
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("represents listening and transcribing states", () => {
    render(<Palette />);
    act(() => usePalette.getState().setListening(true));
    expect(presence()).toBe("listening");
    expect(screen.getByText("Listening…")).toBeInTheDocument();
    act(() => usePalette.getState().setListening(false));
    expect(presence()).toBe("transcribing");
  });

  it("surfaces a pending approval from another device when summoned", async () => {
    bridge.route("GET /api/approvals", () => ({ items: [sampleApproval({ id: "apr_9", runId: "run_other", title: "Reply to Mr. Smith" })] }));
    render(<Palette />);
    await waitFor(() => expect(screen.getByText("Reply to Mr. Smith")).toBeInTheDocument());
  });
});

describe("approval delivery", () => {
  it("does not reset an in-progress edit when the same approval arrives again", async () => {
    const user = userEvent.setup();
    render(<Palette />);
    act(() => bridge.server("approval.requested", { approval: sampleApproval() }));
    const body = await screen.findByLabelText("Message");
    await user.type(body, " Thanks!");
    act(() => bridge.server("approval.requested", { approval: sampleApproval() }));
    expect(screen.getByLabelText("Message")).toHaveValue("Sounds good. I'll be there around 6. Thanks!");
  });
});

describe("provider integration", () => {
  it("streams assistant text while the run is in progress", async () => {
    const user = userEvent.setup();
    render(<Palette />);
    await user.type(screen.getByLabelText("Ask Lou"), "what's up{Enter}");
    await waitFor(() => expect(presence()).toBe("thinking"));
    act(() => bridge.server("agent.delta", { runId: "run_1", text: "Mr. Smith " }));
    act(() => bridge.server("agent.delta", { runId: "run_1", text: "asked about Friday." }));
    expect(screen.getByTestId("stream")).toHaveTextContent("Mr. Smith asked about Friday.");
    act(() => bridge.server("agent.completed", { runId: "run_1", status: "completed", message: "Mr. Smith asked about Friday.", error: null }));
    await waitFor(() => expect(screen.getByTestId("answer")).toHaveTextContent("Mr. Smith asked about Friday."));
    await waitFor(() => expect(screen.queryByTestId("stream")).not.toBeInTheDocument());
  });

  it("offers an explicit retry with the other provider instead of switching silently", async () => {
    const user = userEvent.setup();
    render(<Palette />);
    await user.type(screen.getByLabelText("Ask Lou"), "hello{Enter}");
    act(() =>
      bridge.server("agent.completed", {
        runId: "run_1",
        status: "failed",
        message: null,
        error: { code: "NOT_CONFIGURED", message: "Codex CLI isn't signed in. Run: codex login", details: { provider: "codex_cli", fallbackProvider: "openai_api" } },
      }),
    );
    await waitFor(() => expect(presence()).toBe("failure"));
    expect(screen.getByRole("alert")).toHaveTextContent("codex login");
    expect(bridge.apiCalls("/api/runs")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Try with OpenAI API" }));
    const retry = bridge.apiCalls("/api/runs")[1];
    expect(retry.body).toMatchObject({ text: "hello", provider: "openai_api" });
  });
});
