import { NextResponse } from "next/server";
import { requireUser, UnauthorizedError } from "@/lib/db/auth";
import {
  parseFile,
  normalizeRows,
  mapColumns,
  detectPlatform,
  ParseError,
  MAX_UPLOAD_BYTES,
  ACCEPTED_EXTENSIONS,
} from "@/lib/analysis/parse";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Step 1 of the upload flow: parse the file and return a preview plus the
 * proposed column mapping. Nothing is persisted here — the user confirms the
 * mapping first, and only then does /api/upload/confirm write to the database.
 */
export async function POST(request: Request) {
  try {
    await requireUser();

    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file was received." }, { status: 400 });
    }
    if (file.size === 0) {
      return NextResponse.json({ error: "That file is empty." }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` },
        { status: 413 },
      );
    }
    const lower = file.name.toLowerCase();
    if (!ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      return NextResponse.json(
        { error: `AdMate reads ${ACCEPTED_EXTENSIONS.join(", ")} files. PDF exports are not supported yet — export as CSV instead.` },
        { status: 415 },
      );
    }

    const buffer = await file.arrayBuffer();
    const table = parseFile(file.name, buffer);
    const detected = detectPlatform(table.headers);
    const mappings = mapColumns(table.headers, table.rows, detected.platform);
    const normalized = normalizeRows(table, mappings);

    return NextResponse.json({
      filename: file.name,
      platform: detected.platform,
      platformConfidence: detected.confidence,
      headers: table.headers,
      mappings,
      previewRows: table.rows.slice(0, 20),
      totalRows: table.rows.length,
      issues: normalized.issues,
      availableMetrics: normalized.availableMetrics,
      hasDates: normalized.hasDates,
      deepestLevel: normalized.deepestLevel,
      dateRange: normalized.dateRange,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof ParseError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    console.error("upload/preview failed:", error);
    return NextResponse.json(
      { error: "That file could not be read. Check that it is a valid CSV or Excel export." },
      { status: 500 },
    );
  }
}
