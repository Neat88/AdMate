"use client";

import { Button } from "@/components/ui/primitives";

/**
 * Printing is the sharing mechanism in this MVP: the browser's own
 * "Save as PDF" produces a clean document from the print stylesheet, with no
 * server-side PDF pipeline to build or maintain. Hosted share links would need
 * access-control decisions this version does not make.
 */
export function PrintButton() {
  return (
    <Button variant="secondary" onClick={() => window.print()}>
      Print or save as PDF
    </Button>
  );
}
