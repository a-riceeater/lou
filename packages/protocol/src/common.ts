import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const RiskLevelSchema = z.enum(["read", "write", "destructive", "privileged"]);
export type RiskLevelDto = z.infer<typeof RiskLevelSchema>;

export const RunStatusSchema = z.enum([
  "created",
  "reasoning",
  "waiting_for_tool",
  "waiting_for_approval",
  "resuming",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "failed", "cancelled"];

export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "expired", "executed", "failed"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ErrorDtoSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorDto = z.infer<typeof ErrorDtoSchema>;

export const IsoDate = z.string();
