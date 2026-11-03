const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { inspectChanges, validComment, snapshot, run, runWithStatus, STATUS_CONTEXT } = require("./policy-guard.cjs");
const { inspect, isPolicyPath, isApplicationPath } = require("./policy.cjs");
const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
const TRUSTED = "c".repeat(40);
const OWNER = { login: "mickey-kras", id: 24433677, type: "User" };
const entry = (sha = SHA, mode = "100644") => ({ sha, mode, type: "blob" });

test("all gate inputs, including the real ESLint config, scripts and pins, are protected", () => {
  for (const name of [
    "eslint.config.mjs",
    "playwright.config.ts",
    "tsconfig.json",
    "vite.config.ts",
    ".npmrc",
    ".pnpmfile.cjs",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".github/workflows/quality.yml",
    ".github/trusted-ci/policy-guard.cjs",
    ".vale/styles/test.yml",
    "scripts/check.cjs",
    "sonar-project.properties",
  ]) {
    assert.equal(isPolicyPath(name), true, name);
    assert.ok(
      inspectChanges({}, { [name]: entry() }).some((message) => message.includes("exact-head")),
      name,
    );
  }
  assert.equal(isPolicyPath("app/main.tsx"), false);
});

test("rejects scanner replacement, deletion, additions and symlinks; admits only policy-only updates", () => {
  const name = ".github/workflows/quality.yml";
  const base = { [name]: entry(BASE), "app/main.tsx": entry(BASE) };
  assert.deepEqual(inspectChanges(base, base), []);
  for (const head of [
    { ...base, [name]: entry() },
    { "app/main.tsx": entry(BASE) },
    { ...base, ".github/workflows/bypass.yml": entry() },
  ]) {
    assert.ok(inspectChanges(base, head).length);
    assert.deepEqual(inspectChanges(base, head, true), []);
  }
  assert.ok(
    inspectChanges(base, { ...base, [name]: entry(SHA, "120000") }, true).some((message) =>
      message.includes("regular file"),
    ),
  );
  assert.ok(
    inspectChanges(base, { [name]: entry(), "app/main.tsx": entry() }, true).includes(
      "Separate CI policy changes from application changes",
    ),
  );
});

test("policy changes allow prose but reject application and executable changes", () => {
  const base = { "eslint.config.mjs": entry(BASE) };
  for (const name of ["README.md", "SECURITY.md", "docs/policy.markdown", "docs/setup.rst", "LICENSE", "NOTICE.txt"]) {
    assert.equal(isApplicationPath(name), false, name);
    assert.deepEqual(inspectChanges(base, { "eslint.config.mjs": entry(), [name]: entry() }, true), [], name);
  }
  for (const name of [
    "app/main.tsx",
    "worker/main.ts",
    "db/schema.ts",
    "drizzle/migration.sql",
    "tests/check.test.ts",
    "main.mjs",
    "tools/bypass.py",
    "docs/executable.mdx",
  ]) {
    assert.equal(isApplicationPath(name), true, name);
    assert.ok(
      inspectChanges(base, { "eslint.config.mjs": entry(), [name]: entry() }, true).includes(
        "Separate CI policy changes from application changes",
      ),
      name,
    );
  }
});

test("owner comment admission binds exact head, base and trusted policy and supports revocation", () => {
  const comment = { id: 1, user: OWNER, body: `Approve CI policy: head=${SHA} base=${BASE} trusted=${TRUSTED}` };
  assert.equal(validComment([comment], SHA, BASE, TRUSTED), true);
  assert.equal(validComment([comment], BASE, BASE, TRUSTED), false);
  assert.equal(validComment([comment], SHA, SHA, TRUSTED), false);
  assert.equal(validComment([comment], SHA, BASE, SHA), false);
  assert.equal(validComment([{ ...comment, user: { ...OWNER, id: 1 } }], SHA, BASE, TRUSTED), false);
  assert.equal(validComment([{ ...comment, user: { ...OWNER, type: "Bot" } }], SHA, BASE, TRUSTED), false);
  assert.equal(
    validComment([comment, { ...comment, id: 2, body: "Reject CI policy: revoked" }], SHA, BASE, TRUSTED),
    false,
  );
});

function harness({
  fork = false,
  admitted = false,
  stale = false,
  mutate = false,
  mixed = false,
  approvedReview = false,
  rejectedComment = false,
  staleBase = false,
  staleTrusted = false,
  revoked = false,
} = {}) {
  const repository = resolve(__dirname, "../..");
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: repository, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const blobs = {};
  const tree = files.map((name, index) => {
    const sha = index.toString(16).padStart(40, "0");
    if (/^\.github\/workflows\/.*\.ya?ml$/.test(name)) blobs[sha] = readFileSync(resolve(repository, name), "utf8");
    return { path: name, sha, type: "blob", mode: "100644" };
  });
  const candidate = structuredClone(tree);
  const policy = candidate.find((file) => file.path === ".github/workflows/quality.yml");
  policy.sha = "d".repeat(40);
  // All original required job names remain. The candidate policy inspector accepts
  // this no-op scanner; the independent trusted guard must reject its changed blob.
  blobs[policy.sha] = blobs[tree.find((file) => file.path === policy.path).sha].replace(
    /name: Semgrep\n\s+run: '[\s\S]*?(?=\n    - name: Trivy dependency report)/,
    'name: Semgrep\n      run: "true"',
  );
  assert.match(blobs[policy.sha], /name: Semgrep\n      run: "true"/);
  const workflows = Object.fromEntries(
    candidate.filter((file) => file.path.startsWith(".github/workflows/")).map((file) => [file.path, blobs[file.sha]]),
  );
  assert.deepEqual(inspect(workflows), [], "candidate job-name inspection still accepts the bypass");
  if (mixed)
    candidate.find((file) => file.path === "app/routes/home.tsx" || file.path.startsWith("app/")).sha = "e".repeat(40);
  const pull = {
    number: 1,
    state: "open",
    user: approvedReview ? { id: 1234 } : OWNER,
    head: { sha: SHA, repo: { full_name: fork ? "attacker/repo" : "owner/repo" } },
    base: { sha: BASE },
  };
  let reads = 0;
  let commentReads = 0;
  const statuses = [];
  const github = {
    rest: {
      repos: {
        createCommitStatus: async (status) => {
          statuses.push(status);
        },
      },
      pulls: {
        get: async () => ({ data: { ...pull, head: { ...pull.head, sha: mutate && ++reads > 1 ? BASE : SHA } } }),
        listReviews: "reviews",
      },
      issues: { listComments: "comments" },
      git: {
        getCommit: async ({ commit_sha }) => ({ data: { tree: { sha: commit_sha } } }),
        getTree: async ({ tree_sha }) => ({
          data: { truncated: false, tree: tree_sha === TRUSTED ? tree : candidate },
        }),
        getBlob: async ({ file_sha }) => ({
          data: { encoding: "base64", content: Buffer.from(blobs[file_sha]).toString("base64") },
        }),
      },
    },
    paginate: async (kind) => {
      if (kind === "reviews" && approvedReview) return [{ id: 1, user: OWNER, state: "APPROVED", commit_id: SHA }];
      if (kind === "comments" && revoked && ++commentReads > 1) return [];
      if (kind === "comments" && rejectedComment) return [{ id: 2, user: OWNER, body: "Reject CI policy: revoked" }];
      return kind === "comments" && admitted
        ? [
            {
              id: 1,
              user: OWNER,
              body: `Approve CI policy: head=${stale ? BASE : SHA} base=${staleBase ? SHA : BASE} trusted=${staleTrusted ? SHA : TRUSTED}`,
            },
          ]
        : [];
    },
  };
  return { github, context: { repo: { owner: "owner", repo: "repo" }, payload: { pull_request: pull } }, statuses };
}

test("trusted API guard rejects run:true scanner bypass and fork/stale admissions without executing head code", async () => {
  await assert.rejects(run(harness(), TRUSTED), /exact-head/);
  await run(harness({ admitted: true }), TRUSTED);
  await assert.rejects(run(harness({ approvedReview: true }), TRUSTED), /exact-head/);
  await assert.rejects(run(harness({ approvedReview: true, rejectedComment: true }), TRUSTED), /exact-head/);
  await assert.rejects(run(harness({ approvedReview: true, admitted: true, stale: true }), TRUSTED), /exact-head/);
  await assert.rejects(run(harness({ admitted: true, fork: true }), TRUSTED), /exact-head/);
  await assert.rejects(run(harness({ admitted: true, stale: true }), TRUSTED), /exact-head/);
  await assert.rejects(run(harness({ admitted: true, staleBase: true }), TRUSTED), /exact-head/);
  await assert.rejects(run(harness({ admitted: true, staleTrusted: true }), TRUSTED), /exact-head/);
  await assert.rejects(run(harness({ admitted: true, revoked: true }), TRUSTED), /admission changed/);
  await assert.rejects(run(harness({ admitted: true, mixed: true }), TRUSTED), /Separate CI/);
  await assert.rejects(run(harness({ admitted: true, mutate: true }), TRUSTED), /revision changed/);
});

test("truncated trees fail closed", async () => {
  const github = {
    rest: {
      git: {
        getCommit: async () => ({ data: { tree: { sha: SHA } } }),
        getTree: async () => ({ data: { truncated: true, tree: [] } }),
      },
    },
  };
  await assert.rejects(snapshot(github, {}, SHA), /truncated/);
});

test("live comment events publish required status on PR head and revoke green on reject/edit/delete", async () => {
  for (const action of ["created", "edited", "deleted"]) {
    const passing = harness({ admitted: true });
    const expected = passing.context.payload.pull_request;
    passing.context.payload = { action, issue: { number: expected.number, pull_request: {} } };
    await runWithStatus(passing, expected, TRUSTED);
    assert.deepEqual(
      passing.statuses.map((status) => status.state),
      ["pending", "success"],
    );
    for (const status of passing.statuses) {
      assert.equal(status.sha, SHA);
      assert.equal(status.context, STATUS_CONTEXT);
    }
    // A new live evaluation reads current API comments, never the event's old body.
    for (const options of [{ rejectedComment: true }, {}, { admitted: true, staleBase: true }]) {
      const revoked = harness(options);
      revoked.context.payload = passing.context.payload;
      await assert.rejects(runWithStatus(revoked, expected, TRUSTED), /exact-head/);
      assert.deepEqual(
        revoked.statuses.map((status) => status.state),
        ["pending", "failure"],
      );
    }
  }
});

test("trusted workflow covers comment revocation and base retarget without executing candidate code", () => {
  const YAML = require("yaml");
  const workflow = YAML.parse(readFileSync(resolve(__dirname, "../workflows/policy-guard.yml"), "utf8"));
  assert.deepEqual(workflow.on.issue_comment.types, ["created", "edited", "deleted"]);
  assert.ok(workflow.on.pull_request_target.types.includes("edited"));
  assert.equal(workflow.permissions.statuses, "write");
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.jobs.guard.concurrency["cancel-in-progress"], true);
  const steps = workflow.jobs.guard.steps;
  assert.equal(steps[0].id, "pending");
  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ github.workflow_sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  assert.match(workflow.jobs.guard.if, /comment.user.id == 24433677/);
  assert.match(workflow.jobs.guard.if, /comment.user.login == 'mickey-kras'/);
  assert.ok(!steps.some((step) => String(step.run || "").includes("candidate")));
});
