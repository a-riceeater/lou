import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { BridgeError, setBridge } from "../bridge/bridge";
import { Pairing } from "../screens/Pairing";
import { TestBridge } from "./testBridge";

class FailingPairBridge extends TestBridge {
  constructor(private readonly error: BridgeError) {
    super();
  }

  override async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === "pairing.complete") throw this.error;
    return super.request<T>(method, params);
  }
}

async function submit(error: BridgeError) {
  setBridge(new FailingPairBridge(error));
  const user = userEvent.setup();
  render(<Pairing />);
  await user.type(screen.getByLabelText("Server address"), "https://lou.example.com");
  await user.type(screen.getByLabelText("Pairing code"), "ABCD-EFGH");
  await user.click(screen.getByRole("button", { name: "Connect" }));
}

describe("pairing errors", () => {
  it("explains a refused code instead of claiming the device was signed out", async () => {
    await submit(new BridgeError("PAIRING_REJECTED", "That pairing code is invalid or has expired. Codes work once and expire after 10 minutes."));
    expect(await screen.findByText(/invalid or has expired/)).toBeInTheDocument();
    expect(screen.queryByText(/signed out/i)).not.toBeInTheDocument();
  });

  it("shows the server's reason even from an older native host that reports UNAUTHORIZED", async () => {
    await submit(new BridgeError("UNAUTHORIZED", "That pairing code is invalid or has expired."));
    expect(await screen.findByText("That pairing code is invalid or has expired.")).toBeInTheDocument();
    expect(screen.queryByText(/signed out/i)).not.toBeInTheDocument();
  });

  it("reports a proxy or wrong server answering instead of Lou", async () => {
    await submit(new BridgeError("PAIRING_FAILED", "https://lou.example.com answered HTTP 502 instead of Lou."));
    expect(await screen.findByText(/answered HTTP 502 instead of Lou/)).toBeInTheDocument();
  });
});
