const { test } = require("node:test");
const assert = require("node:assert/strict");
const { inspect } = require("./policy.cjs");
const YAML = require("yaml");
const fixture = () => ({
  ".github/workflows/ci.yml": YAML.stringify({
    jobs: {
      verify: {},
      quality: {},
      checks: { if: "always()", needs: ["verify", "quality"] },
      sonar: {},
      deploy: { needs: ["checks", "sonar"] },
    },
  }),
  ".github/workflows/quality.yml": YAML.stringify({
    jobs: Object.fromEntries(
      ["policy", "security", "aislop", "codeql", "docs", "branch", "dependencies"].map((name) => [name, {}]),
    ),
  }),
});
test("rejects bypassed dependency chain and removed scanner", () => {
  const files = fixture();
  assert.deepEqual(inspect(files), []);
  files[".github/workflows/ci.yml"] = files[".github/workflows/ci.yml"].replace("      - sonar\n", "");
  files[".github/workflows/quality.yml"] = files[".github/workflows/quality.yml"].replace("  security: {}\n", "");
  assert.ok(inspect(files).includes("Deployment omits sonar"));
  assert.ok(inspect(files).includes("Missing quality job: security"));
});
test("rejects mutable action references and ignored failures", () => {
  const files = fixture();
  files["other.yml"] = YAML.stringify({
    jobs: { scan: { steps: [{ uses: "actions/checkout@main", "continue-on-error": true }] } },
  });
  assert.ok(inspect(files).some((message) => message.includes("unpinned action")));
  assert.ok(inspect(files).some((message) => message.includes("ignored failures")));
});
test("rejects duplicate YAML keys instead of accepting a shadowed gate", () => {
  assert.throws(() => inspect({ "other.yml": "jobs: {}\njobs: {}\n" }));
});
