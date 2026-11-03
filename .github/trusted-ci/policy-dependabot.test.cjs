const { test } = require("node:test");
const assert = require("node:assert/strict");
const YAML = require("yaml");
const {
  admittedDependabot,
  dependencyVersionsOnly,
  actionPinsOnly,
  lockControlsUnchanged,
} = require("./policy-dependabot.cjs");

const OLD = "a".repeat(40);
const NEXT = "b".repeat(40);
const pull = {
  user: { login: "dependabot[bot]", id: 49699333, type: "Bot" },
  head: { ref: "dependabot/npm_and_yarn/update", repo: { full_name: "owner/repo" } },
};
const manifest = {
  name: "test",
  scripts: { lint: "eslint ." },
  engines: { node: ">=24" },
  dependencies: { yaml: "2.9.1" },
};
const nextManifest = { ...manifest, dependencies: { yaml: "2.9.2" } };
const lock = {
  lockfileVersion: "9.0",
  settings: { autoInstallPeers: true },
  overrides: { dependency: "1.0.0" },
  importers: { ".": { dependencies: { yaml: { specifier: "2.9.1", version: "2.9.1" } } } },
  packages: { "yaml@2.9.1": { resolution: { integrity: "sha512-test" } } },
  snapshots: { "yaml@2.9.1": {} },
};
const nextLock = {
  ...lock,
  importers: { ".": { dependencies: { yaml: { specifier: "2.9.2", version: "2.9.2" } } } },
  packages: { "yaml@2.9.2": { resolution: { integrity: "sha512-next" } } },
  snapshots: { "yaml@2.9.2": {} },
};
const workflow = {
  on: { pull_request: {} },
  permissions: { contents: "read" },
  jobs: {
    scan: {
      "runs-on": "ubuntu-latest",
      steps: [{ uses: `actions/checkout@${OLD}` }, { uses: "./.github/actions/local" }, { run: "npm test" }],
    },
  },
};

function fixture(changes = {}) {
  const original = {
    ".github/trusted-ci/package.json": JSON.stringify(manifest),
    ".github/trusted-ci/package-lock.json": "{}",
    "package.json": JSON.stringify(manifest),
    "pnpm-lock.yaml": YAML.stringify(lock),
    ".github/workflows/ci.yml": YAML.stringify(workflow),
  };
  const candidate = {
    ...original,
    "package.json": JSON.stringify(nextManifest),
    "pnpm-lock.yaml": YAML.stringify(nextLock),
    ...changes,
  };
  const contents = new Map();
  let serial = 0;
  const snapshot = (files) =>
    Object.fromEntries(
      Object.entries(files).map(([name, source]) => {
        const sha = String(++serial).padStart(40, "0");
        contents.set(sha, source);
        return [name, { sha, type: "blob", mode: "100644" }];
      }),
    );
  const base = snapshot(original);
  const head = snapshot(candidate);
  for (const name of Object.keys(original)) if (candidate[name] === original[name]) head[name] = base[name];
  return { base, head, read: async (entry) => contents.get(entry.sha) };
}
const admit = (fixture, author = pull) =>
  admittedDependabot(author, "owner/repo", fixture.base, fixture.head, fixture.read);

test("verified same-repository Dependabot can update only existing dependency versions and matching locks", async () => {
  assert.equal(await admit(fixture()), true);
  for (const user of [
    { ...pull.user, id: 1 },
    { ...pull.user, login: "attacker" },
    { ...pull.user, type: "User" },
  ]) {
    assert.equal(await admit(fixture(), { ...pull, user }), false);
  }
  assert.equal(
    await admit(fixture(), { ...pull, head: { ...pull.head, repo: { full_name: "attacker/repo" } } }),
    false,
  );
  assert.equal(await admit(fixture(), { ...pull, head: { ...pull.head, ref: "attacker" } }), false);
});

test("dependency admission cannot alter scripts, engines, package manager or dependency identities and sources", async () => {
  for (const after of [
    { ...nextManifest, scripts: { lint: "true" } },
    { ...nextManifest, engines: { node: ">=1" } },
    { ...nextManifest, packageManager: "pnpm@1.0.0" },
    { ...nextManifest, dependencies: { yaml: "npm:other@1.0.0" } },
    { ...nextManifest, dependencies: { yaml: "file:./payload" } },
    { ...nextManifest, dependencies: { yaml: "https://evil/package.tgz" } },
    { ...nextManifest, dependencies: { yaml: "^2.9.2" } },
    { ...nextManifest, dependencies: { yaml: "2.9.2", other: "1.0.0" } },
    { ...nextManifest, dependencies: {} },
  ]) {
    assert.equal(dependencyVersionsOnly(manifest, after), false);
    assert.equal(await admit(fixture({ "package.json": JSON.stringify(after) })), false);
  }
});

test("lock-only graph updates retain controls and importer consistency", async () => {
  const graphOnly = { ...lock, snapshots: { ...lock.snapshots, "transitive@1.0.1": {} } };
  assert.equal(
    await admit(fixture({ "package.json": JSON.stringify(manifest), "pnpm-lock.yaml": YAML.stringify(graphOnly) })),
    true,
  );
  for (const after of [
    { ...nextLock, settings: { autoInstallPeers: false } },
    { ...nextLock, overrides: {} },
    { ...nextLock, patchedDependencies: { yaml: "payload.patch" } },
    { ...nextLock, importers: { ".": { dependencies: { yaml: { specifier: "2.9.1", version: "2.9.2" } } } } },
    { ...nextLock, importers: { ".": { dependencies: { yaml: { specifier: "2.9.2", version: "link:./payload" } } } } },
    { ...nextLock, importers: { ...nextLock.importers, other: {} } },
  ])
    assert.equal(await admit(fixture({ "pnpm-lock.yaml": YAML.stringify(after) })), false);
});

test("action updates change only full remote SHA pins while preserving all execution controls", async () => {
  const updated = structuredClone(workflow);
  updated.jobs.scan.steps[0].uses = `actions/checkout@${NEXT}`;
  const oldYaml = YAML.stringify(workflow);
  const nextYaml = YAML.stringify(updated);
  assert.equal(actionPinsOnly(oldYaml, nextYaml), true);
  assert.equal(
    await admit(
      fixture({
        "package.json": JSON.stringify(manifest),
        "pnpm-lock.yaml": YAML.stringify(lock),
        ".github/workflows/ci.yml": nextYaml,
      }),
    ),
    true,
  );
  for (const mutate of [
    (value) => {
      value.jobs.scan.steps[0].uses = "actions/checkout@main";
    },
    (value) => {
      value.jobs.scan.steps[0].uses = `attacker/action@${NEXT}`;
    },
    (value) => {
      value.jobs.scan.steps[0].uses = { action: "actions/checkout", immutable: true };
    },
    (value) => {
      value.jobs.scan.steps[1].uses = "./.github/actions/payload";
    },
    (value) => {
      value.jobs.scan.steps[2].run = "true";
    },
    (value) => {
      value.jobs.scan.steps[0].with = { ref: "attacker" };
    },
    (value) => {
      value.jobs.scan["continue-on-error"] = true;
    },
    (value) => {
      value.permissions.contents = "write";
    },
  ]) {
    const malicious = structuredClone(updated);
    mutate(malicious);
    assert.equal(actionPinsOnly(oldYaml, YAML.stringify(malicious)), false);
  }
});

test("automatic admission rejects additions, deletions, modes, mixed source and all other policy changes", async () => {
  for (const name of [
    ".npmrc",
    "pnpm-workspace.yaml",
    ".github/trusted-ci/policy-guard.cjs",
    ".github/trusted-ci/package.json",
    ".github/trusted-ci/package-lock.json",
    "app/main.tsx",
    "README.md",
  ]) {
    assert.equal(await admit(fixture({ [name]: "payload" })), false, name);
  }
  const deleted = fixture();
  delete deleted.head["package.json"];
  assert.equal(await admit(deleted), false);
  const symlink = fixture();
  symlink.head["package.json"].mode = "120000";
  assert.equal(await admit(symlink), false);
  const workflowAdded = fixture({ ".github/workflows/payload.yml": YAML.stringify(workflow) });
  assert.equal(await admit(workflowAdded), false);
});

test("lock-only non-registry resolution replacements require owner admission", async () => {
  for (const resolution of [
    { tarball: "https://example.invalid/payload.tgz" },
    { integrity: "sha512-test", tarball: "https://example.invalid/payload.tgz" },
    { tarball: "file:./payload.tgz" },
    { directory: "./payload", type: "directory" },
    { repo: "https://example.invalid/repository.git", commit: OLD, type: "git" },
    { integrity: "file:./payload.tgz" },
    {},
  ]) {
    const after = { ...lock, packages: { "yaml@2.9.1": { resolution } } };
    assert.equal(lockControlsUnchanged(lock, after, manifest), false);
    assert.equal(
      await admit(fixture({ "package.json": JSON.stringify(manifest), "pnpm-lock.yaml": YAML.stringify(after) })),
      false,
    );
  }
  const nonRegistryKey = {
    ...lock,
    packages: { "https://example.invalid/payload.tgz": { resolution: { integrity: "sha512-test" } } },
  };
  assert.equal(lockControlsUnchanged(lock, nonRegistryKey, manifest), false);
});
