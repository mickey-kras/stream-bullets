const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const YAML = require("yaml");

const workflow = YAML.parse(readFileSync(join(__dirname, "../workflows/docs-ste.yml"), "utf8"));

function prepare(script, source, openapi = false) {
  const root = mkdtempSync(join(tmpdir(), "docs-ste-test-"));
  try {
    const repo = join(root, "repo");
    const temp = join(root, "runner");
    mkdirSync(repo);
    mkdirSync(temp);
    execFileSync("git", ["init", "-q", repo]);
    const path = openapi ? "api.json" : "guide.md";
    writeFileSync(
      join(repo, path),
      openapi ? JSON.stringify({ openapi: "3.1.0", info: { description: source } }) : source,
    );
    execFileSync("git", ["add", path], { cwd: repo });
    const result = spawnSync("bash", ["-c", script], {
      cwd: repo,
      env: { ...process.env, RUNNER_TEMP: temp },
      encoding: "utf8",
    });
    return { ...result, staged: result.status === 0 ? readFileSync(join(temp, "docs-ste", `${path}.md`), "utf8") : "" };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const id of ["ste-cli", "vale"]) {
  const script = workflow.jobs[id].steps.find((step) => step.name === "Prepare documentation").run;
  for (const openapi of [false, true]) {
    const format = openapi ? "OpenAPI prose" : "Markdown";
    test(`${id} rejects linter control comments in ${format}`, () => {
      for (const directive of [
        "<!-- ste-disable -->",
        "<!--ste-disable STE-3.6-->",
        "<!-- ste-disable-next-line -->",
        "<!-- ste-disable-line STE-3.6 -->",
        "<!-- ste-enable -->",
        "<!-- ste-disable",
        "<!--\u00a0STE-DISABLE\u2003STE-3.6 -->",
        "<!--\nvale off\n-->",
        "<!-- VALE OFF -->",
        "<!-- vale on -->",
        "<!-- vale STE = NO -->",
        "<!-- vale STE.PassiveVoice = off -->",
        '<!-- vale STE.Dictionary["utilize"] = NO -->',
        "<!-- vale styles = Vale -->",
        "<!-- vale style = Vale -->",
        "<!-- vale STE.PassiveVoice = YES -->",
      ]) {
        const result = prepare(script, `${directive}\nThe file was deleted.\n`, openapi);
        assert.notEqual(result.status, 0, directive);
        assert.match(result.stderr, /linter control comments are not permitted/, directive);
      }
    });
    test(`${id} preserves ordinary comments and prose in ${format}`, () => {
      const source = "<!-- This is an ordinary comment. -->\nThe app checks the file.\n";
      const result = prepare(script, source, openapi);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.staged.includes(source));
    });
  }
}

test("STE checks all prose without a candidate baseline", () => {
  const action = workflow.jobs["ste-cli"].steps.find((step) => step.uses?.startsWith("TudorAndrei/ste-cli@"));
  assert.match(action.with.args, /--no-baseline\b/);
  assert.match(action.with.args, /--warnings-as-errors\b/);
});
