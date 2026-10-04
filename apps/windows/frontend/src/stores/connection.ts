import type { ConnectionState } from "@lou/protocol";
import { create } from "zustand";

export const useConnection = create<{ state: ConnectionState; set(state: ConnectionState): void }>((set) => ({
  state: { state: "connecting", serverUrl: null, deviceId: null },
  set: (state) => set({ state }),
}));
