const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const publish = require("./publish.cjs");

for (const scenario of [
  "current",
  "superseded",
  "raced",
  "fork",
  "closed",
  "push-race",
  "base-changed",
  "base-raced",
  "merge",
  "wrong-artifact",
]) {
  test(`publication: ${scenario}`, async () => {
    const original = process.cwd();
    const directory = mkdtempSync(join(tmpdir(), "graph-publish-"));
    const expected = { number: 1, head: { sha: "source" }, base: { ref: "main", sha: "base" } };
    const pull = {
      number: 1,
      base: { ref: "main", sha: "stale-recorded-base" },
      state: scenario === "closed" ? "closed" : "open",
      head: {
        sha: scenario === "superseded" ? "new" : "source",
        ref: "feat/example",
        repo: { full_name: scenario === "fork" ? "other/repo" : "owner/repo" },
      },
    };
    let reads = 0;
    let baseReads = 0;
    const updates = [];
    const dispatches = [];
    const github = {
      rest: {
        actions: {
          createWorkflowDispatch: async (args) => {
            dispatches.push(args);
          },
        },
        pulls: {
          get: async () => ({
            data: ++reads === 2 && scenario === "raced" ? { ...pull, head: { ...pull.head, sha: "new" } } : pull,
          }),
        },
        git: {
          getRef: async (args) => {
            assert.equal(args.ref, "heads/main");
            baseReads += 1;
            return {
              data: {
                object: {
                  sha:
                    scenario === "base-changed" || (scenario === "base-raced" && baseReads === 2) ? "new-base" : "base",
                },
              },
            };
          },
          getCommit: async () => ({ data: { tree: { sha: "base-tree" } } }),
          createBlob: async () => ({ data: { sha: "blob" } }),
          createTree: async (args) => {
            assert.deepEqual(args.tree, [
              { path: "graphify-out/graph.json", mode: "100644", type: "blob", sha: "blob" },
            ]);
            return { data: { sha: "tree" } };
          },
          createCommit: async (args) => {
            assert.deepEqual(args.parents, scenario === "merge" ? ["source", "base"] : ["source"]);
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
      writeFileSync(
        "graph-artifact/graph-update.json",
        JSON.stringify({
          head: scenario === "wrong-artifact" ? "wrong" : "source",
          base: "base",
          merge: scenario === "merge",
          entries: [{ path: "graphify-out/graph.json", mode: "100644", type: "blob", content: "e30=" }],
        }),
      );
      const result = publish({
        github,
        expected,
        context: { repo: { owner: "owner", repo: "repo" }, payload: { pull_request: expected } },
        core: { info: () => {} },
      });
      if (scenario === "push-race") await assert.rejects(result, /fast forward/);
      else if (scenario === "wrong-artifact") await assert.rejects(result, /revision mismatch/);
      else await result;
      assert.equal(updates.length, ["current", "merge"].includes(scenario) ? 1 : 0);
      assert.deepEqual(
        dispatches,
        ["current", "merge"].includes(scenario)
          ? [
              {
                owner: "owner",
                repo: "repo",
                workflow_id: "ci.yml",
                ref: "feat/example",
                inputs: { number: "1", expected_head: "generated", base_sha: "base" },
              },
              {
                owner: "owner",
                repo: "repo",
                workflow_id: "policy-guard.yml",
                ref: "main",
                inputs: { number: "1", expected_head: "generated" },
              },
            ]
          : [],
      );
    } finally {
      process.chdir(original);
      rmSync(directory, { recursive: true });
    }
  });
}
