const { readFileSync } = require("node:fs");

module.exports = async function publish({ github, context, core, expected }) {
  const params = { ...context.repo, pull_number: expected.number };
  const { data: pull } = await github.rest.pulls.get(params);
  const { data: base } = await github.rest.git.getRef({ ...context.repo, ref: `heads/${expected.base.ref}` });
  if (
    pull.state !== "open" ||
    pull.head.sha !== expected.head.sha ||
    pull.base.ref !== expected.base.ref ||
    base.object.sha !== expected.base.sha ||
    pull.head.repo.full_name !== `${context.repo.owner}/${context.repo.repo}`
  ) {
    core.info("PR changed; discard the old graph.");
    return;
  }
  const update = JSON.parse(readFileSync("graph-artifact/graph-update.json", "utf8"));
  if (update.head !== expected.head.sha || update.base !== expected.base.sha) {
    throw new Error("Graph artifact revision mismatch");
  }
  const { data: parent } = await github.rest.git.getCommit({ ...context.repo, commit_sha: expected.head.sha });
  const entries = [];
  for (const entry of update.entries) {
    const { content, ...item } = entry;
    if (content !== undefined) {
      const { data: blob } = await github.rest.git.createBlob({ ...context.repo, content, encoding: "base64" });
      item.sha = blob.sha;
    }
    entries.push(item);
  }
  const { data: tree } = await github.rest.git.createTree({
    ...context.repo,
    base_tree: parent.tree.sha,
    tree: entries,
  });
  const { data: commit } = await github.rest.git.createCommit({
    ...context.repo,
    message: update.merge ? "chore: merge main and refresh repository graph" : "docs: refresh repository graph",
    tree: tree.sha,
    parents: update.merge ? [expected.head.sha, expected.base.sha] : [expected.head.sha],
  });
  const { data: latest } = await github.rest.pulls.get(params);
  const { data: latestBase } = await github.rest.git.getRef({ ...context.repo, ref: `heads/${expected.base.ref}` });
  if (
    latest.state !== "open" ||
    latest.head.sha !== expected.head.sha ||
    latest.base.ref !== expected.base.ref ||
    latestBase.object.sha !== expected.base.sha
  ) {
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
    inputs: { ...inputs, base_sha: expected.base.sha },
  });
  await github.rest.actions.createWorkflowDispatch({
    ...context.repo,
    workflow_id: "policy-guard.yml",
    ref: "main",
    inputs,
  });
};
