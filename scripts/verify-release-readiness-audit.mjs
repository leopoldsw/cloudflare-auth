import { readFile } from "node:fs/promises";

import {
  collectReleaseReadinessAuditFailures,
  collectReleaseReadinessAuditPathReferenceFailures,
  collectReleaseReadinessAuditTestReferenceFailures,
  releaseReadinessAuditPath,
} from "./release-readiness-audit-checks.mjs";

let audit = "";
try {
  audit = await readFile(releaseReadinessAuditPath, "utf8");
} catch {
  console.error(`${releaseReadinessAuditPath}: could not be read`);
  process.exit(1);
}

const failures = [
  ...collectReleaseReadinessAuditFailures(audit),
  ...collectReleaseReadinessAuditPathReferenceFailures(audit),
  ...collectReleaseReadinessAuditTestReferenceFailures(audit),
];
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("release readiness audit verified");
