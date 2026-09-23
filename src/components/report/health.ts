/** Key used to join breakdown-table rows with diagnoses (server- and client-safe). */
export function healthKey(level: string, campaign: string | null, adset: string | null, name: string): string {
  return [level, campaign ?? "", adset ?? "", name].join("\u0000");
}
