import type { ApprovalView, NotificationView, RunStatus } from "@lou/protocol";
import type { SerializedError } from "@lou/shared";
import type { Logger } from "../logger";

/**
 * In-process typed event bus. Modules publish domain events; the device gateway
 * (and anything else) subscribes. Keeps modules decoupled: the approval manager
 * does not know about WebSockets, the runtime does not know about devices.
 */
export interface BusEvents {
  "run.progress": { userId: string; runId: string; status: RunStatus; label?: string };
  "run.completed": { userId: string; runId: string; status: RunStatus; message: string | null; error: SerializedError | null };
  "approval.requested": { userId: string; approval: ApprovalView };
  "approval.resolved": { userId: string; approvalId: string; status: string; runId: string | null };
  "notification.created": { userId: string; notification: NotificationView };
  "device.revoked": { userId: string; deviceId: string };
}

type Handler<K extends keyof BusEvents> = (payload: BusEvents[K]) => void;

export class EventBus {
  private readonly handlers = new Map<keyof BusEvents, Set<Handler<never>>>();

  constructor(private readonly logger?: Logger) {}

  on<K extends keyof BusEvents>(event: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        (handler as Handler<K>)(payload);
      } catch (err) {
        this.logger?.error({ err, event }, "bus handler failed");
      }
    }
  }
}
