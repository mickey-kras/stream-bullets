const { inspect, isPolicyPath, isApplicationPath } = require("./policy.cjs");

const { DEPENDENCY_FILES, applicationDependenciesOnly } = require("./policy-dependencies.cjs");
const { admittedDependabot } = require("./policy-dependabot.cjs");

const OWNER = { login: "mickey-kras", id: 24433677 };
const SHA = /^[a-f0-9]{40}$/;

// A repository owner cannot approve their own PR. An explicit comment is an
// admission bound to the candidate, current base and trusted policy.
function commentAdmission(comments, head, base, trusted, tree) {
  const prefix = /^(Approve|Reject) CI policy: /;
  const decisive = comments.filter(
    (comment) =>
      Number.isSafeInteger(comment.id) &&
      comment.user?.login === OWNER.login &&
      comment.user?.id === OWNER.id &&
      comment.user?.type === "User" &&
      prefix.test(comment.body || ""),
  );
  decisive.sort((a, b) => b.id - a.id);
  if (!decisive.length) return undefined;
  return (
    decisive[0].body === `Approve CI policy: head=${head} base=${base} trusted=${trusted}` ||
    (SHA.test(tree || "") && decisive[0].body === `Approve CI policy: tree=${tree} base=${base} trusted=${trusted}`)
  );
}

function validComment(comments, head, base, trusted, tree) {
  return commentAdmission(comments, head, base, trusted, tree) === true;
}

function inspectChanges(base, head, admitted = false, dependencyOnly = false) {
  const failures = [];
  const paths = new Set([...Object.keys(base), ...Object.keys(head)]);
  const changed = [...paths].filter(
    (name) => base[name]?.sha !== head[name]?.sha || base[name]?.mode !== head[name]?.mode,
  );
  const policy = changed.filter((name) => isPolicyPath(name) && !(dependencyOnly && DEPENDENCY_FILES.includes(name)));
  if (policy.length && changed.some(isApplicationPath)) {
    failures.push("Separate CI policy changes from application changes");
  }
  if (policy.length && !admitted) failures.push("CI policy changes require exact-head or exact-tree owner approval");
  for (const [name, entry] of Object.entries(head)) {
    if (isPolicyPath(name) && (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))) {
      failures.push(`Policy input must be a regular file: ${name}`);
    }
  }
  return failures;
}

async function snapshot(github, repo, sha) {
  if (!SHA.test(sha)) throw new Error("Invalid revision");
  const { data: commit } = await github.rest.git.getCommit({ ...repo, commit_sha: sha });
  const { data: tree } = await github.rest.git.getTree({ ...repo, tree_sha: commit.tree.sha, recursive: "1" });
  if (tree.truncated) throw new Error("Cannot inspect truncated repository tree");
  return Object.fromEntries(tree.tree.filter((entry) => entry.type !== "tree").map((entry) => [entry.path, entry]));
}

async function run({ github, context }, trustedSha = process.env.TRUSTED_SHA) {
  const expected = context.payload.pull_request;
  if (!expected || !SHA.test(trustedSha || "")) throw new Error("Missing trusted pull request context");
  const params = { ...context.repo, pull_number: expected.number };
  const { data: pull } = await github.rest.pulls.get(params);
  const current = (candidate) =>
    candidate.state === "open" &&
    candidate.head?.sha === expected.head.sha &&
    candidate.base?.sha === expected.base.sha;
  if (!current(pull)) throw new Error("Pull request revision changed; rerun on the current head");
  const base = await snapshot(github, context.repo, trustedSha);
  // Read candidate Git objects as inert data; never checkout or load candidate code.
  const head = await snapshot(github, context.repo, pull.head.sha);
  const cache = new Map();
  const read = async (entry) => {
    if (!cache.has(entry.sha)) {
      const { data: blob } = await github.rest.git.getBlob({ ...context.repo, file_sha: entry.sha });
      if (blob.encoding !== "base64") throw new Error("Unsupported policy blob encoding");
      cache.set(entry.sha, Buffer.from(blob.content, "base64").toString("utf8"));
    }
    return cache.get(entry.sha);
  };
  let dependencyOnly = false;
  if (
    DEPENDENCY_FILES.some((name) => base[name]?.sha !== head[name]?.sha) &&
    DEPENDENCY_FILES.every(
      (name) =>
        base[name]?.type === "blob" &&
        head[name]?.type === "blob" &&
        base[name].mode === "100644" &&
        head[name].mode === "100644",
    )
  ) {
    const sources = async (entries) =>
      Object.fromEntries(await Promise.all(DEPENDENCY_FILES.map(async (name) => [name, await read(entries[name])])));
    dependencyOnly = applicationDependenciesOnly(await sources(base), await sources(head));
  }
  const { data: headCommit } = await github.rest.git.getCommit({ ...context.repo, commit_sha: pull.head.sha });
  const tree = headCommit.tree.sha;
  if (!SHA.test(tree || "")) throw new Error("Invalid tree revision");
  const automated = await admittedDependabot(pull, `${context.repo.owner}/${context.repo.repo}`, base, head, read);
  let admitted = automated;
  const changedPolicy = [...new Set([...Object.keys(base), ...Object.keys(head)])].some(
    (name) =>
      isPolicyPath(name) &&
      !(dependencyOnly && DEPENDENCY_FILES.includes(name)) &&
      (base[name]?.sha !== head[name]?.sha || base[name]?.mode !== head[name]?.mode),
  );
  if (changedPolicy && pull.head.repo?.full_name === `${context.repo.owner}/${context.repo.repo}`) {
    const comments = await github.paginate(github.rest.issues.listComments, {
      ...context.repo,
      issue_number: pull.number,
      per_page: 100,
    });
    const decision = commentAdmission(comments, pull.head.sha, pull.base.sha, trustedSha, tree);
    if (decision !== undefined) admitted = decision;
  }
  const failures = inspectChanges(base, head, admitted, dependencyOnly);
  const workflows = {};
  for (const [name, entry] of Object.entries(head)) {
    if (!/^\.github\/workflows\/.*\.ya?ml$/.test(name)) continue;
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) continue;
    workflows[name] = await read(entry);
  }
  failures.push(...inspect(workflows));
  const { data: latest } = await github.rest.pulls.get(params);
  if (!current(latest)) failures.push("Pull request revision changed during validation");
  if (changedPolicy && admitted) {
    const comments = await github.paginate(github.rest.issues.listComments, {
      ...context.repo,
      issue_number: pull.number,
      per_page: 100,
    });
    const decision = commentAdmission(comments, pull.head.sha, pull.base.sha, trustedSha, tree);
    if (!(decision ?? automated)) {
      failures.push("Owner policy admission changed during validation");
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

const STATUS_CONTEXT = "Trusted CI policy";

// Both entry points run trusted code. The early workflow step binds the status
// to a live API revision; run() rechecks it before and after inspecting Git data.
async function runWithStatus({ github, context }, expected, trustedSha = process.env.TRUSTED_SHA) {
  if (
    !Number.isSafeInteger(expected?.number) ||
    !SHA.test(expected?.head?.sha || "") ||
    !SHA.test(expected?.base?.sha || "")
  )
    throw new Error("Invalid status revision");
  const status = (state) =>
    github.rest.repos.createCommitStatus({
      ...context.repo,
      sha: expected.head.sha,
      context: STATUS_CONTEXT,
      state,
      description:
        state === "success"
          ? "Trusted policy validation passed"
          : state === "pending"
            ? "Validating current policy admission"
            : "Trusted policy validation failed",
    });
  await status("pending");
  try {
    await run(
      { github, context: { repo: context.repo, payload: { ...context.payload, pull_request: expected } } },
      trustedSha,
    );
    await status("success");
  } catch (error) {
    await status("failure");
    throw error;
  }
}

module.exports = { inspectChanges, validComment, snapshot, run, runWithStatus, STATUS_CONTEXT };
