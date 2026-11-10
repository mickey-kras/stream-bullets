const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const publish = require("./publish.cjs");

for (const scenario of ["current", "superseded", "raced", "fork", "closed", "push-race"]) {
  test(`publication: ${scenario}`, async () => {
    const original = process.cwd();
    const directory = mkdtempSync(join(tmpdir(), "graph-publish-"));
    const expected = { number: 1, head: { sha: "source" } };
    const pull = {
      state: scenario === "closed" ? "closed" : "open",
      head: {
        sha: scenario === "superseded" ? "new" : "source",
        ref: "feat/example",
        repo: { full_name: scenario === "fork" ? "other/repo" : "owner/repo" },
      },
    };
    let reads = 0;
    const updates = [];
    const github = {
      rest: {
        pulls: {
          get: async () => ({
            data: ++reads === 2 && scenario === "raced" ? { ...pull, head: { ...pull.head, sha: "new" } } : pull,
          }),
        },
        git: {
          getCommit: async () => ({ data: { tree: { sha: "base-tree" } } }),
          createBlob: async () => ({ data: { sha: "blob" } }),
          createTree: async (args) => {
            assert.deepEqual(args.tree, [
              { path: "graphify-out/graph.json", mode: "100644", type: "blob", sha: "blob" },
            ]);
            return { data: { sha: "tree" } };
          },
          createCommit: async (args) => {
            assert.deepEqual(args.parents, ["source"]);
            return { data: { sha: "generated" } };
          },
          updateRef: async (args) => {
            assert.equal(args.force, false);
            if (scenario === "push-race") throw new Error("Not a fast forward");
            updates.push(args);
          },
        },
      },
    };
    try {
      process.chdir(directory);
      mkdirSync("graph-artifact");
      writeFileSync("graph-artifact/graph.json", '{"nodes":[]}');
      const result = publish({
        github,
        context: { repo: { owner: "owner", repo: "repo" }, payload: { pull_request: expected } },
        core: { info: () => {} },
      });
      if (scenario === "push-race") await assert.rejects(result, /fast forward/);
      else await result;
      assert.equal(updates.length, scenario === "current" ? 1 : 0);
    } finally {
      process.chdir(original);
      rmSync(directory, { recursive: true });
    }
  });
}
