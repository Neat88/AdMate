import { LinkButton } from "@/components/ui/primitives";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <p className="text-sm font-semibold uppercase tracking-wide text-brand-600">404</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink-900">We couldn&apos;t find that page</h1>
      <p className="mt-2 max-w-md text-sm text-ink-600">
        The report or page you asked for does not exist, or it belongs to a different account.
      </p>
      <LinkButton href="/dashboard" className="mt-6">
        Back to dashboard
      </LinkButton>
    </div>
  );
}
