"use client";

import type { AssistantFocus } from "@/lib/assistant/types";
import { useAssistant } from "./AssistantProvider";

/**
 * The "Ask AdMate" affordance attached to numbers, rows and cards. Renders
 * nothing outside a report (no provider), so shared components stay usable on
 * pages without an assistant.
 */
export function AskButton({
  focus,
  label = "Ask",
  question,
  variant = "chip",
  className = "",
}: {
  focus: AssistantFocus;
  label?: string;
  question?: string;
  variant?: "chip" | "icon" | "button";
  className?: string;
}) {
  const assistant = useAssistant();
  if (!assistant) return null;

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    assistant.ask(focus, question);
  };

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={onClick}
        title="Ask AdMate about this"
        aria-label="Ask AdMate about this"
        className={`no-print inline-flex h-6 w-6 items-center justify-center rounded-md text-brand-600 hover:bg-brand-50 ${className}`}
      >
        <Sparkle />
      </button>
    );
  }
  if (variant === "button") {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`no-print inline-flex items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-100 ${className}`}
      >
        <Sparkle />
        {label}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`no-print inline-flex items-center gap-1 rounded-full border border-brand-200 bg-white px-2 py-0.5 text-xs font-medium text-brand-700 hover:bg-brand-50 ${className}`}
    >
      <Sparkle />
      {label}
    </button>
  );
}

export function Sparkle({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="currentColor">
      <path d="M8 1.5l1.4 3.6a2 2 0 001.1 1.1L14 7.6l-3.5 1.4a2 2 0 00-1.1 1.1L8 13.6l-1.4-3.5a2 2 0 00-1.1-1.1L2 7.6l3.5-1.4a2 2 0 001.1-1.1L8 1.5z" />
    </svg>
  );
}
