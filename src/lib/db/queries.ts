import { getDb } from "./schema";
import { newId } from "./auth";
import type { ColumnMapping } from "@/lib/analysis/columns";
import type { DataIssue } from "@/lib/analysis/parse";
import type { Finding } from "@/lib/analysis/detectors";
import type { Insight } from "@/lib/ai/insights";
import type { NormalizedRow, Platform } from "@/lib/analysis/types";
import type { AlertEvent, AlertRule } from "@/lib/analysis/alerts";
import { defaultRules } from "@/lib/analysis/alerts";

/**
 * Every read in this file takes a `userId` and filters on it.
 *
 * That is the single mechanism preventing one user's advertising data from
 * reaching another's analysis - there is no "fetch by id" helper that skips
 * the ownership check, on purpose.
 */

export type RecommendationStatus = "new" | "in_review" | "action_taken" | "dismissed";

export interface Workspace {
  id: string;
  name: string;
  currency: string;
  createdAt: string;
}

export interface ReportRecord {
  id: string;
  workspaceId: string;
  filename: string;
  platform: Platform;
  currency: string;
  objective: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  rowCount: number;
  createdAt: string;
}

export interface RecommendationRecord {
  id: string;
  analysisId: string;
  reportId: string;
  findingId: string;
  code: string;
  kind: Finding["kind"];
  priority: Finding["priority"];
  severity: number;
  confidence: Finding["confidence"];
  entityLevel: string;
  entityName: string;
  title: string;
  finding: Finding;
  insight: Insight;
  status: RecommendationStatus;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnalysisRecord {
  id: string;
  reportId: string;
  engine: string;
  fallbackReason: string | null;
  summary: string;
  createdAt: string;
}

const now = () => new Date().toISOString();

/* ------------------------------- workspaces ------------------------------ */

export function listWorkspaces(userId: string): Workspace[] {
  return getDb()
    .prepare(
      "SELECT id, name, currency, created_at AS createdAt FROM workspaces WHERE user_id = ? ORDER BY created_at ASC",
    )
    .all(userId) as Workspace[];
}

export function createWorkspace(userId: string, name: string, currency = "USD"): Workspace {
  const db = getDb();
  const id = newId("ws");
  const createdAt = now();
  db.prepare(
    "INSERT INTO workspaces (id, user_id, name, currency, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, userId, name, currency, createdAt);

  // Give the workspace a usable monitoring baseline instead of an empty page.
  for (const rule of defaultRules(id)) {
    db.prepare(
      `INSERT INTO alert_rules (id, workspace_id, user_id, name, metric, comparator, threshold, scope, entity_filter, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(newId("rule"), id, userId, rule.name, rule.metric, rule.comparator, rule.threshold, rule.scope, rule.entityFilter, createdAt);
  }

  return { id, name, currency, createdAt };
}

export function getWorkspace(userId: string, workspaceId: string): Workspace | null {
  return (
    (getDb()
      .prepare(
        "SELECT id, name, currency, created_at AS createdAt FROM workspaces WHERE id = ? AND user_id = ?",
      )
      .get(workspaceId, userId) as Workspace | undefined) ?? null
  );
}

/* -------------------------------- reports -------------------------------- */

export interface SaveReportInput {
  userId: string;
  workspaceId: string;
  filename: string;
  platform: Platform;
  currency: string;
  objective: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  mappings: ColumnMapping[];
  issues: DataIssue[];
  rows: NormalizedRow[];
}

export function saveReport(input: SaveReportInput): string {
  const db = getDb();
  const id = newId("rep");
  const createdAt = now();

  const insertReport = db.prepare(
    `INSERT INTO reports (id, workspace_id, user_id, filename, platform, currency, objective,
                          period_start, period_end, row_count, mapping_json, issues_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRow = db.prepare("INSERT INTO report_rows (report_id, row_json) VALUES (?, ?)");

  db.transaction(() => {
    insertReport.run(
      id,
      input.workspaceId,
      input.userId,
      input.filename,
      input.platform,
      input.currency,
      input.objective,
      input.periodStart,
      input.periodEnd,
      input.rows.length,
      JSON.stringify(input.mappings),
      JSON.stringify(input.issues),
      createdAt,
    );
    for (const row of input.rows) insertRow.run(id, JSON.stringify(row));
  })();

  return id;
}

export function listReports(userId: string, workspaceId?: string): ReportRecord[] {
  const db = getDb();
  const sql = `SELECT id, workspace_id AS workspaceId, filename, platform, currency, objective,
                      period_start AS periodStart, period_end AS periodEnd,
                      row_count AS rowCount, created_at AS createdAt
               FROM reports WHERE user_id = ?${workspaceId ? " AND workspace_id = ?" : ""}
               ORDER BY created_at DESC`;
  return (workspaceId ? db.prepare(sql).all(userId, workspaceId) : db.prepare(sql).all(userId)) as ReportRecord[];
}

export function getReport(userId: string, reportId: string): ReportRecord | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, workspace_id AS workspaceId, filename, platform, currency, objective,
                period_start AS periodStart, period_end AS periodEnd,
                row_count AS rowCount, created_at AS createdAt
         FROM reports WHERE id = ? AND user_id = ?`,
      )
      .get(reportId, userId) as ReportRecord | undefined) ?? null
  );
}

export function getReportIssues(userId: string, reportId: string): DataIssue[] {
  const row = getDb()
    .prepare("SELECT issues_json FROM reports WHERE id = ? AND user_id = ?")
    .get(reportId, userId) as { issues_json: string } | undefined;
  return row ? (JSON.parse(row.issues_json) as DataIssue[]) : [];
}

export function getReportMappings(userId: string, reportId: string): ColumnMapping[] {
  const row = getDb()
    .prepare("SELECT mapping_json FROM reports WHERE id = ? AND user_id = ?")
    .get(reportId, userId) as { mapping_json: string } | undefined;
  return row ? (JSON.parse(row.mapping_json) as ColumnMapping[]) : [];
}

export function getReportRows(userId: string, reportId: string): NormalizedRow[] {
  const db = getDb();
  // Ownership is verified before the rows are touched.
  const owns = db.prepare("SELECT 1 FROM reports WHERE id = ? AND user_id = ?").get(reportId, userId);
  if (!owns) return [];
  const rows = db
    .prepare("SELECT row_json FROM report_rows WHERE report_id = ? ORDER BY id ASC")
    .all(reportId) as { row_json: string }[];
  return rows.map((r) => JSON.parse(r.row_json) as NormalizedRow);
}

export function deleteReport(userId: string, reportId: string): boolean {
  const result = getDb().prepare("DELETE FROM reports WHERE id = ? AND user_id = ?").run(reportId, userId);
  return result.changes > 0;
}

/* -------------------------------- analyses ------------------------------- */

export interface SaveAnalysisInput {
  userId: string;
  reportId: string;
  engine: string;
  fallbackReason: string | null;
  summary: string;
  modelJson: string;
  findings: Finding[];
  insights: Insight[];
}

export function saveAnalysis(input: SaveAnalysisInput): string {
  const db = getDb();
  const id = newId("ana");
  const createdAt = now();

  const insertAnalysis = db.prepare(
    `INSERT INTO analyses (id, report_id, user_id, engine, fallback_reason, summary, model_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRec = db.prepare(
    `INSERT INTO recommendations (id, analysis_id, report_id, user_id, finding_id, code, kind, priority,
                                  severity, confidence, entity_level, entity_name, title,
                                  finding_json, insight_json, status, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', NULL, ?, ?)`,
  );

  db.transaction(() => {
    insertAnalysis.run(
      id,
      input.reportId,
      input.userId,
      input.engine,
      input.fallbackReason,
      input.summary,
      input.modelJson,
      createdAt,
    );
    const insightById = new Map(input.insights.map((i) => [i.findingId, i]));
    for (const finding of input.findings) {
      const insight = insightById.get(finding.id);
      if (!insight) continue;
      insertRec.run(
        newId("rec"),
        id,
        input.reportId,
        input.userId,
        finding.id,
        finding.code,
        finding.kind,
        finding.priority,
        finding.severityScore,
        finding.confidence,
        finding.level,
        finding.entityName,
        finding.title,
        JSON.stringify(finding),
        JSON.stringify(insight),
        createdAt,
        createdAt,
      );
    }
  })();

  return id;
}

export function getLatestAnalysis(userId: string, reportId: string): AnalysisRecord | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, report_id AS reportId, engine, fallback_reason AS fallbackReason, summary, created_at AS createdAt
         FROM analyses WHERE report_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(reportId, userId) as AnalysisRecord | undefined) ?? null
  );
}

export function getAnalysisModel(userId: string, analysisId: string): string | null {
  const row = getDb()
    .prepare("SELECT model_json FROM analyses WHERE id = ? AND user_id = ?")
    .get(analysisId, userId) as { model_json: string } | undefined;
  return row?.model_json ?? null;
}

/* ----------------------------- recommendations --------------------------- */

interface RecRow {
  id: string;
  analysisId: string;
  reportId: string;
  findingId: string;
  code: string;
  kind: string;
  priority: string;
  severity: number;
  confidence: string;
  entityLevel: string;
  entityName: string;
  title: string;
  finding_json: string;
  insight_json: string;
  status: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

function hydrate(row: RecRow): RecommendationRecord {
  return {
    id: row.id,
    analysisId: row.analysisId,
    reportId: row.reportId,
    findingId: row.findingId,
    code: row.code,
    kind: row.kind as Finding["kind"],
    priority: row.priority as Finding["priority"],
    severity: row.severity,
    confidence: row.confidence as Finding["confidence"],
    entityLevel: row.entityLevel,
    entityName: row.entityName,
    title: row.title,
    finding: JSON.parse(row.finding_json) as Finding,
    insight: JSON.parse(row.insight_json) as Insight,
    status: row.status as RecommendationStatus,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Builds the recommendation column list, optionally table-qualified for joins. */
function recColumns(prefix = ""): string {
  const p = prefix ? `${prefix}.` : "";
  return [
    `${p}id`,
    `${p}analysis_id AS analysisId`,
    `${p}report_id AS reportId`,
    `${p}finding_id AS findingId`,
    `${p}code`,
    `${p}kind`,
    `${p}priority`,
    `${p}severity`,
    `${p}confidence`,
    `${p}entity_level AS entityLevel`,
    `${p}entity_name AS entityName`,
    `${p}title`,
    `${p}finding_json`,
    `${p}insight_json`,
    `${p}status`,
    `${p}note`,
    `${p}created_at AS createdAt`,
    `${p}updated_at AS updatedAt`,
  ].join(", ");
}

export function listRecommendationsForAnalysis(userId: string, analysisId: string): RecommendationRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT ${recColumns()} FROM recommendations WHERE analysis_id = ? AND user_id = ? ORDER BY severity DESC`,
    )
    .all(analysisId, userId) as RecRow[];
  return rows.map(hydrate);
}

export function listAllRecommendations(
  userId: string,
  filters: { status?: RecommendationStatus; priority?: string; workspaceId?: string } = {},
): RecommendationRecord[] {
  const clauses = ["r.user_id = ?"];
  const params: unknown[] = [userId];
  if (filters.status) {
    clauses.push("r.status = ?");
    params.push(filters.status);
  }
  if (filters.priority) {
    clauses.push("r.priority = ?");
    params.push(filters.priority);
  }
  if (filters.workspaceId) {
    clauses.push("rep.workspace_id = ?");
    params.push(filters.workspaceId);
  }
  const rows = getDb()
    .prepare(
      `SELECT ${recColumns("r")}
       FROM recommendations r
       JOIN reports rep ON rep.id = r.report_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY r.severity DESC, r.created_at DESC`,
    )
    .all(...params) as RecRow[];
  return rows.map(hydrate);
}

export function updateRecommendationStatus(
  userId: string,
  recommendationId: string,
  status: RecommendationStatus,
  note?: string | null,
): boolean {
  const result = getDb()
    .prepare(
      "UPDATE recommendations SET status = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ? AND user_id = ?",
    )
    .run(status, note ?? null, now(), recommendationId, userId);
  return result.changes > 0;
}

/* --------------------------------- alerts -------------------------------- */

interface RuleRow {
  id: string;
  workspaceId: string;
  name: string;
  metric: string;
  comparator: string;
  threshold: number;
  scope: string;
  entityFilter: string | null;
  enabled: number;
  createdAt: string;
}

export function listAlertRules(userId: string, workspaceId?: string): AlertRule[] {
  const db = getDb();
  const sql = `SELECT id, workspace_id AS workspaceId, name, metric, comparator, threshold, scope,
                      entity_filter AS entityFilter, enabled, created_at AS createdAt
               FROM alert_rules WHERE user_id = ?${workspaceId ? " AND workspace_id = ?" : ""}
               ORDER BY created_at ASC`;
  const rows = (workspaceId ? db.prepare(sql).all(userId, workspaceId) : db.prepare(sql).all(userId)) as RuleRow[];
  return rows.map((r) => ({ ...r, enabled: r.enabled === 1 }) as AlertRule);
}

export function createAlertRule(
  userId: string,
  rule: Omit<AlertRule, "id" | "createdAt">,
): AlertRule {
  const id = newId("rule");
  const createdAt = now();
  getDb()
    .prepare(
      `INSERT INTO alert_rules (id, workspace_id, user_id, name, metric, comparator, threshold, scope, entity_filter, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      rule.workspaceId,
      userId,
      rule.name,
      rule.metric,
      rule.comparator,
      rule.threshold,
      rule.scope,
      rule.entityFilter,
      rule.enabled ? 1 : 0,
      createdAt,
    );
  return { ...rule, id, createdAt };
}

export function setAlertRuleEnabled(userId: string, ruleId: string, enabled: boolean): boolean {
  const result = getDb()
    .prepare("UPDATE alert_rules SET enabled = ? WHERE id = ? AND user_id = ?")
    .run(enabled ? 1 : 0, ruleId, userId);
  return result.changes > 0;
}

export function deleteAlertRule(userId: string, ruleId: string): boolean {
  const result = getDb().prepare("DELETE FROM alert_rules WHERE id = ? AND user_id = ?").run(ruleId, userId);
  return result.changes > 0;
}

export function saveAlertEvents(
  userId: string,
  analysisId: string,
  reportId: string,
  events: AlertEvent[],
): void {
  if (events.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO alert_events (id, rule_id, analysis_id, report_id, user_id, severity, entity_name, metric, message, acknowledged, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  );
  const createdAt = now();
  db.transaction(() => {
    for (const e of events) {
      stmt.run(newId("evt"), e.ruleId, analysisId, reportId, userId, e.severity, e.entityName, e.metric, e.message, createdAt);
    }
  })();
}

export interface AlertEventRecord {
  id: string;
  ruleId: string;
  reportId: string;
  severity: string;
  entityName: string;
  metric: string;
  message: string;
  acknowledged: boolean;
  createdAt: string;
  reportFilename: string;
}

export function listAlertEvents(userId: string, limit = 50): AlertEventRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT e.id, e.rule_id AS ruleId, e.report_id AS reportId, e.severity, e.entity_name AS entityName,
              e.metric, e.message, e.acknowledged, e.created_at AS createdAt, r.filename AS reportFilename
       FROM alert_events e JOIN reports r ON r.id = e.report_id
       WHERE e.user_id = ? ORDER BY e.created_at DESC LIMIT ?`,
    )
    .all(userId, limit) as (Omit<AlertEventRecord, "acknowledged"> & { acknowledged: number })[];
  return rows.map((r) => ({ ...r, acknowledged: r.acknowledged === 1 }));
}

export function acknowledgeAlertEvent(userId: string, eventId: string): boolean {
  const result = getDb()
    .prepare("UPDATE alert_events SET acknowledged = 1 WHERE id = ? AND user_id = ?")
    .run(eventId, userId);
  return result.changes > 0;
}

/* ------------------------------ dashboard agg ---------------------------- */

export interface DashboardCounts {
  reports: number;
  openRecommendations: number;
  highPriority: number;
  unacknowledgedAlerts: number;
}

export function dashboardCounts(userId: string, workspaceId?: string): DashboardCounts {
  const db = getDb();
  const wsClause = workspaceId ? " AND workspace_id = ?" : "";
  const wsParams = workspaceId ? [workspaceId] : [];

  const reports = (
    db.prepare(`SELECT COUNT(*) AS n FROM reports WHERE user_id = ?${wsClause}`).get(userId, ...wsParams) as { n: number }
  ).n;

  const recClause = workspaceId ? " AND rep.workspace_id = ?" : "";
  const open = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM recommendations r JOIN reports rep ON rep.id = r.report_id
         WHERE r.user_id = ? AND r.status IN ('new','in_review')${recClause}`,
      )
      .get(userId, ...wsParams) as { n: number }
  ).n;

  const high = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM recommendations r JOIN reports rep ON rep.id = r.report_id
         WHERE r.user_id = ? AND r.priority = 'high' AND r.status IN ('new','in_review')${recClause}`,
      )
      .get(userId, ...wsParams) as { n: number }
  ).n;

  const alerts = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM alert_events e JOIN reports rep ON rep.id = e.report_id
         WHERE e.user_id = ? AND e.acknowledged = 0${recClause}`,
      )
      .get(userId, ...wsParams) as { n: number }
  ).n;

  return { reports, openRecommendations: open, highPriority: high, unacknowledgedAlerts: alerts };
}
