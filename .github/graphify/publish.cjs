const { readFileSync } = require("node:fs");

module.exports = async function publish({ github, context, core }) {
  const expected = context.payload.pull_request;
  const params = { ...context.repo, pull_number: expected.number };
  const { data: pull } = await github.rest.pulls.get(params);
  if (
    pull.state !== "open" ||
    pull.head.sha !== expected.head.sha ||
    pull.head.repo.full_name !== `${context.repo.owner}/${context.repo.repo}`
  ) {
    core.info("PR changed; discard the old graph.");
    return;
  }
  const graph = readFileSync("graph-artifact/graph.json", "utf8");
  JSON.parse(graph);
  const { data: parent } = await github.rest.git.getCommit({ ...context.repo, commit_sha: expected.head.sha });
  const { data: blob } = await github.rest.git.createBlob({ ...context.repo, content: graph, encoding: "utf-8" });
  const { data: tree } = await github.rest.git.createTree({
    ...context.repo,
    base_tree: parent.tree.sha,
    tree: [{ path: "graphify-out/graph.json", mode: "100644", type: "blob", sha: blob.sha }],
  });
  const { data: commit } = await github.rest.git.createCommit({
    ...context.repo,
    message: "docs: refresh repository graph",
    tree: tree.sha,
    parents: [expected.head.sha],
  });
  const { data: latest } = await github.rest.pulls.get(params);
  if (latest.state !== "open" || latest.head.sha !== expected.head.sha) {
    core.info("PR changed during generation; discard the old graph.");
    return;
  }
  // The API rejects a concurrent update because this commit has the old parent.
  await github.rest.git.updateRef({
    ...context.repo,
    ref: `heads/${pull.head.ref}`,
    sha: commit.sha,
    force: false,
  });
  const inputs = { number: String(pull.number), expected_head: commit.sha };
  // GITHUB_TOKEN writes do not start ordinary CI without approval. Dispatch it explicitly.
  await github.rest.actions.createWorkflowDispatch({
    ...context.repo,
    workflow_id: "ci.yml",
    ref: pull.head.ref,
    inputs: { ...inputs, base_sha: pull.base.sha },
  });
  await github.rest.actions.createWorkflowDispatch({
    ...context.repo,
    workflow_id: "policy-guard.yml",
    ref: "main",
    inputs,
  });
};
