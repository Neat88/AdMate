import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <Link href="/" className="mb-6 flex items-center gap-2">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-base font-bold text-white"
        >
          A
        </span>
        <span className="text-xl font-semibold tracking-tight text-ink-900">AdMate</span>
      </Link>
      <div className="w-full max-w-sm rounded-xl border border-ink-200 bg-white p-6 shadow-sm">
        {children}
      </div>
      <p className="mt-6 max-w-sm text-center text-xs leading-relaxed text-ink-500">
        AdMate analyses advertising reports you upload. It never connects to or changes your live
        ad accounts.
      </p>
    </div>
  );
}
