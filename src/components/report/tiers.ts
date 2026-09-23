import type { Tier } from "@/lib/analysis/diagnoses";

/** Visual treatment per tier. Every tier carries a glyph and a label, never colour alone. */
export const TIER_STYLE: Record<Tier, { label: string; glyph: string; chip: string; rail: string }> = {
  critical: {
    label: "Critical",
    glyph: "●",
    chip: "border-high-200 bg-high-50 text-high-700",
    rail: "bg-high-500",
  },
  attention: {
    label: "Needs attention",
    glyph: "▲",
    chip: "border-med-200 bg-med-50 text-med-700",
    rail: "bg-med-500",
  },
  monitor: {
    label: "Monitor",
    glyph: "◐",
    chip: "border-low-200 bg-low-50 text-low-700",
    rail: "bg-low-500",
  },
  performing: {
    label: "Performing well",
    glyph: "✓",
    chip: "border-good-200 bg-good-50 text-good-700",
    rail: "bg-good-500",
  },
};

export const TIER_ORDER: Tier[] = ["critical", "attention", "monitor", "performing"];
