const { readFileSync } = require("node:fs");
const assert = require("node:assert/strict");
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.equal(report.version, "2.1.0");
assert.ok(Array.isArray(report.runs) && report.runs.length > 0);
for (const run of report.runs) {
  assert.equal(run.tool?.driver?.name, "aislop");
  assert.ok(Array.isArray(run.results));
  for (const finding of run.results) {
    assert.ok(typeof finding.ruleId === "string" && finding.ruleId.length > 0);
    assert.ok(typeof finding.message?.text === "string");
    assert.ok(["error", "warning", "note"].includes(finding.level));
  }
}
const findings = report.runs
  .flatMap((run) => run.results)
  .filter((finding) => finding.ruleId !== "security/vulnerable-dependency");
if (findings.length)
  throw new Error(
    `Aislop reported ${findings.length} findings: ${[...new Set(findings.map((finding) => finding.ruleId))].join(", ")}`,
  );
