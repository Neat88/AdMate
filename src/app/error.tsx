"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/primitives";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <h1 className="text-xl font-semibold text-ink-900">Something went wrong</h1>
      <p className="mt-2 max-w-md text-sm text-ink-600">
        AdMate hit an unexpected error. Your uploaded reports are unaffected.
      </p>
      {error.digest ? (
        <p className="mt-2 text-xs text-ink-400">Reference: {error.digest}</p>
      ) : null}
      <Button onClick={reset} className="mt-6">
        Try again
      </Button>
    </div>
  );
}
