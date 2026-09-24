import type { ReactNode } from "react";
import Link from "next/link";

/* -------------------------------------------------------------------------- */
/* Layout primitives                                                          */
/* -------------------------------------------------------------------------- */

export function Card({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article";
}) {
  return (
    <Tag className={`rounded-xl border border-ink-200 bg-white shadow-[0_1px_2px_rgba(18,25,38,0.04)] ${className}`}>
      {children}
    </Tag>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-200 px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-ink-500">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink-900 sm:text-2xl">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-ink-600">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-ink-300 bg-white px-6 py-12 text-center">
      {icon ? <div className="mb-3 text-ink-400">{icon}</div> : null}
      <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-ink-500">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Buttons                                                                    */
/* -------------------------------------------------------------------------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-300",
  secondary: "border border-ink-300 bg-white text-ink-700 hover:bg-ink-50 disabled:text-ink-400",
  ghost: "text-ink-600 hover:bg-ink-100 hover:text-ink-900",
  danger: "border border-high-200 bg-white text-high-700 hover:bg-high-50",
};

export function buttonClass(variant: ButtonVariant = "primary", size: "sm" | "md" = "md"): string {
  const sizing = size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm";
  return `inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed ${sizing} ${BUTTON_STYLES[variant]}`;
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" }) {
  return (
    <button className={`${buttonClass(variant, size)} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function LinkButton({
  href,
  children,
  variant = "primary",
  size = "md",
  className = "",
}: {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <Link href={href} className={`${buttonClass(variant, size)} ${className}`}>
      {children}
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
/* Status indicators                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Priority badge.
 *
 * Carries a shape glyph as well as a colour, so the severity is still legible
 * in greyscale, to a colour-blind user, or when printed.
 */
export function PriorityBadge({ priority }: { priority: "high" | "medium" | "low" }) {
  const config = {
    high: { label: "High priority", glyph: "▲", cls: "border-high-200 bg-high-50 text-high-700" },
    medium: { label: "Medium priority", glyph: "◆", cls: "border-med-200 bg-med-50 text-med-700" },
    low: { label: "Low priority", glyph: "●", cls: "border-low-200 bg-low-50 text-low-700" },
  }[priority];

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${config.cls}`}
    >
      <span aria-hidden="true">{config.glyph}</span>
      {config.label}
    </span>
  );
}

export function KindBadge({ kind }: { kind: "issue" | "opportunity" | "win" }) {
  const config = {
    issue: { label: "Issue", cls: "border-ink-300 bg-ink-50 text-ink-700" },
    opportunity: { label: "Opportunity", cls: "border-good-200 bg-good-50 text-good-700" },
    win: { label: "Working well", cls: "border-good-200 bg-good-50 text-good-700" },
  }[kind];
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${config.cls}`}>
      {config.label}
    </span>
  );
}

export function ConfidenceBadge({ level, reason }: { level: "high" | "medium" | "low"; reason?: string }) {
  const filled = level === "high" ? 3 : level === "medium" ? 2 : 1;
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-ink-500"
      title={reason}
    >
      <span className="flex gap-0.5" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`h-1.5 w-1.5 rounded-full ${i < filled ? "bg-ink-500" : "bg-ink-200"}`}
          />
        ))}
      </span>
      {level} confidence
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; cls: string }> = {
    new: { label: "New", cls: "border-brand-200 bg-brand-50 text-brand-700" },
    in_review: { label: "In review", cls: "border-med-200 bg-med-50 text-med-700" },
    action_taken: { label: "Action taken", cls: "border-good-200 bg-good-50 text-good-700" },
    dismissed: { label: "Dismissed", cls: "border-ink-200 bg-ink-50 text-ink-500" },
  };
  const c = config[status] ?? config.new;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${c.cls}`}>
      {c.label}
    </span>
  );
}

/**
 * A change indicator that states its own direction in words for screen readers
 * and uses an arrow glyph, so meaning does not depend on the red/green colour.
 */
export function DeltaChip({
  change,
  isGood,
  className = "",
}: {
  change: number | null;
  isGood: boolean | null;
  className?: string;
}) {
  if (change === null || !Number.isFinite(change)) {
    return <span className={`text-xs text-ink-400 ${className}`}>no comparison</span>;
  }
  if (Math.abs(change) < 0.0005) {
    return (
      <span className={`inline-flex items-center rounded bg-ink-100 px-1.5 py-0.5 text-xs font-medium text-ink-600 tnum ${className}`}>
        no change
      </span>
    );
  }
  const up = change > 0;
  const tone =
    isGood === null
      ? "bg-ink-100 text-ink-600"
      : isGood
        ? "bg-good-50 text-good-700"
        : "bg-high-50 text-high-700";

  return (
    <span className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-medium tnum ${tone} ${className}`}>
      <span aria-hidden="true">{up ? "↑" : "↓"}</span>
      <span className="sr-only">{up ? "up" : "down"} </span>
      {Math.abs(change * 100).toFixed(1)}%
    </span>
  );
}

export function Banner({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warning" | "error" | "success";
  title: string;
  children?: ReactNode;
}) {
  const config = {
    info: { cls: "border-brand-200 bg-brand-50 text-brand-900", glyph: "i" },
    warning: { cls: "border-med-200 bg-med-50 text-med-700", glyph: "!" },
    error: { cls: "border-high-200 bg-high-50 text-high-700", glyph: "×" },
    success: { cls: "border-good-200 bg-good-50 text-good-700", glyph: "✓" },
  }[tone];

  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${config.cls}`} role={tone === "error" ? "alert" : undefined}>
      <div className="flex gap-2.5">
        <span
          aria-hidden="true"
          className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current text-[10px] font-bold"
        >
          {config.glyph}
        </span>
        <div className="min-w-0">
          <p className="font-semibold">{title}</p>
          {children ? <div className="mt-1 text-sm opacity-90">{children}</div> : null}
        </div>
      </div>
    </div>
  );
}

/** Marks a feature that is simulated or limited in the MVP. */
export function ModeTag({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded border border-ink-200 bg-ink-50 px-1.5 py-0.5 text-[11px] font-medium text-ink-600"
    >
      {children}
    </span>
  );
}
