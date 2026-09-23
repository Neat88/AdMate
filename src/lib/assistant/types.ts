import type { MetricKey } from "@/lib/analysis/types";

/**
 * What the user was looking at when they asked. Sent with every question so
 * "why did this change?" never needs the campaign or metric spelled out.
 * Entity ids are the performance model's ids ("campaign:<name>", ...).
 */
export type AssistantFocus =
  | { kind: "report" }
  | { kind: "metric"; metric: MetricKey; entityId: string | null }
  | { kind: "diagnosis"; diagnosisId: string }
  | { kind: "entity"; entityId: string }
  | { kind: "change"; metric: MetricKey };

export interface Suggestion {
  id: SuggestionId;
  text: string;
}

export type SuggestionId =
  | "explain_metric"
  | "why_change"
  | "is_good"
  | "what_to_do"
  | "why_problem"
  | "should_pause"
  | "alternatives"
  | "how_sure"
  | "entity_health"
  | "entity_drivers"
  | "compare_peers"
  | "which_first"
  | "is_real"
  | "prioritize"
  | "biggest_problem"
  | "whats_working";

/** The structured answer format: facts, interpretation and advice kept apart. */
export interface AnswerBlocks {
  /** What happened - facts from the report. */
  observation: string;
  /** The numbers that support it, one per line. */
  evidence: string[];
  /** What it likely means - clearly interpretation. */
  interpretation: string;
  /** What to consider doing. */
  recommendation: string;
  /** How sure, and why. */
  confidence: string;
  /** What the report cannot tell us. */
  limitations: string[];
}

export interface AssistantAnswer {
  blocks: AnswerBlocks;
  followUps: string[];
  engine: "claude" | "local";
  /** Shown when the answer was downgraded (validation failure, quota, no key). */
  notice?: string | null;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text?: string;
  answer?: AssistantAnswer;
  focusLabel?: string | null;
  createdAt: string;
}

/** Events streamed from the assistant endpoint as newline-delimited JSON. */
export type AssistantEvent =
  | { type: "status"; text: string }
  | { type: "answer"; message: ChatMessage }
  | { type: "error"; error: string };
