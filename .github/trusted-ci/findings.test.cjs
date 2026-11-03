const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function validate(report) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "findings-"));
  try {
    const file = path.join(directory, "report.json");
    fs.writeFileSync(file, JSON.stringify(report));
    return spawnSync(process.execPath, [path.join(__dirname, "findings.cjs"), file]).status;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
const report = (results) => ({ version: "2.1.0", runs: [{ tool: { driver: { name: "aislop" } }, results }] });

test("empty verified results pass, findings at every severity fail", () => {
  assert.equal(validate(report([])), 0);
  for (const level of ["error", "warning", "note"]) {
    assert.notEqual(validate(report([{ ruleId: "lint/test", message: { text: "issue" }, level }])), 0);
  }
});

test("missing or malformed scan results cannot pass as an empty report", () => {
  for (const invalid of [{}, { version: "2.1.0", runs: [] }, report(null), report([{}])]) {
    assert.notEqual(validate(invalid), 0);
  }
});
