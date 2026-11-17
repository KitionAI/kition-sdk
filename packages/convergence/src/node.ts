/** Node-only helpers: how a kit's test hands its report to `tools/check-manifest.mjs --convergence`. */
import { writeFileSync } from 'node:fs'
import type { Report } from './report'

/**
 * Writes the report's JSON to the file `KITION_CONVERGENCE_REPORT` names, when it is set, as the
 * Rust `Report::save_if_requested` does.
 */
export function saveReportIfRequested(report: Report, env: Record<string, string | undefined> = process.env): void {
  const path = env.KITION_CONVERGENCE_REPORT
  if (path) writeFileSync(path, report.toJsonText())
}
