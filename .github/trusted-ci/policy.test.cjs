const { test } = require("node:test");
const assert = require("node:assert/strict");
const { inspect } = require("./policy.cjs");
const YAML = require("yaml");
const fixture = () => ({
  ".github/workflows/ci.yml": YAML.stringify({
    jobs: {
      verify: {},
      graphify: {},
      quality: {},
      checks: { if: "always()", needs: ["verify", "quality", "graphify"] },
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

const { applicationDependenciesOnly } = require("./policy-dependencies.cjs");
const dependencyFixture = () => {
  const manifest = {
    scripts: { test: "vitest run" },
    packageManager: "pnpm@11.25.0",
    dependencies: { react: "1.0.0" },
    devDependencies: { vitest: "1.0.0" },
  };
  const resolution = { integrity: "sha512-YWJj" };
  const lock = {
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: true },
    importers: {
      ".": {
        dependencies: { react: { specifier: "1.0.0", version: "1.0.0" } },
        devDependencies: { vitest: { specifier: "1.0.0", version: "1.0.0" } },
      },
    },
    packages: { "react@1.0.0": { resolution }, "vitest@1.0.0": { resolution }, "assertion@1.0.0": { resolution } },
    snapshots: { "react@1.0.0": {}, "vitest@1.0.0": { dependencies: { assertion: "1.0.0" } }, "assertion@1.0.0": {} },
  };
  return { manifest, lock };
};
const sourcePair = ({ manifest, lock }) => ({
  "package.json": JSON.stringify(manifest),
  "pnpm-lock.yaml": YAML.stringify(lock),
});
function addDependency(fixture, name, group = "dependencies") {
  fixture.manifest[group][name] = "1.0.0";
  fixture.lock.importers["."][group][name] = { specifier: "1.0.0", version: "1.0.0" };
  fixture.lock.packages[`${name}@1.0.0`] = { resolution: { integrity: "sha512-YWJj" } };
  fixture.lock.snapshots[`${name}@1.0.0`] = {};
}

test("application dependencies and matching type packages need no policy admission", () => {
  const before = dependencyFixture();
  const after = structuredClone(before);
  addDependency(after, "three");
  addDependency(after, "@types/three", "devDependencies");
  assert.equal(applicationDependenciesOnly(sourcePair(before), sourcePair(after)), true);
  const updated = structuredClone(after);
  updated.manifest.dependencies.three = "2.0.0";
  updated.lock.importers["."].dependencies.three = { specifier: "2.0.0", version: "2.0.0" };
  updated.lock.packages["three@2.0.0"] = updated.lock.packages["three@1.0.0"];
  updated.lock.snapshots["three@2.0.0"] = {};
  delete updated.lock.packages["three@1.0.0"];
  delete updated.lock.snapshots["three@1.0.0"];
  assert.equal(applicationDependenciesOnly(sourcePair(after), sourcePair(updated)), true);
  assert.equal(applicationDependenciesOnly(sourcePair(after), sourcePair(before)), true);
});

test("application admission rejects tool changes, install controls and lockfile substitution", () => {
  const before = dependencyFixture();
  const mutations = [
    (next) => {
      next.manifest.scripts.test = "true";
    },
    (next) => {
      next.manifest.scripts.postinstall = "node payload.js";
    },
    (next) => {
      next.manifest.packageManager = "pnpm@12.0.0";
    },
    (next) => {
      next.manifest.pnpm = { overrides: { vitest: "2.0.0" } };
    },
    (next) => {
      addDependency(next, "eslint", "devDependencies");
    },
    (next) => {
      addDependency(next, "@types/node", "devDependencies");
    },
    (next) => {
      addDependency(next, "vitest");
    },
    (next) => {
      next.manifest.devDependencies.vitest = "2.0.0";
    },
    (next) => {
      next.manifest.dependencies.three = "npm:vitest@1.0.0";
    },
    (next) => {
      next.lock.settings.autoInstallPeers = false;
    },
    (next) => {
      next.lock.packages["assertion@1.0.0"].resolution.integrity = "sha512-ZGVm";
    },
    (next) => {
      next.lock.snapshots["assertion@1.0.0"].dependencies = { three: "1.0.0" };
    },
    (next) => {
      delete next.lock.packages["assertion@1.0.0"];
    },
    (next) => {
      next.lock.importers["."].devDependencies.vitest.version = "2.0.0";
    },
    (next) => {
      next.lock.packages["three@1.0.0"].resolution = { tarball: "https://example.invalid/tool.tgz" };
    },
    (next) => {
      next.lock.importers["."].dependencies.three.version = "2.0.0";
    },
  ];
  for (const mutate of mutations) {
    const next = structuredClone(before);
    addDependency(next, "three");
    mutate(next);
    assert.equal(applicationDependenciesOnly(sourcePair(before), sourcePair(next)), false, mutate.toString());
  }
});

test("direct CLI dependencies require approval on addition, promotion, update and removal", () => {
  const before = dependencyFixture();
  const added = structuredClone(before);
  addDependency(added, "tsc");
  added.lock.packages["tsc@1.0.0"].hasBin = true;
  assert.equal(applicationDependenciesOnly(sourcePair(before), sourcePair(added)), false);
  assert.equal(applicationDependenciesOnly(sourcePair(added), sourcePair(before)), false);

  const transitive = structuredClone(before);
  transitive.lock.packages["playwright@1.0.0"] = { resolution: { integrity: "sha512-YWJj" }, hasBin: true };
  transitive.lock.snapshots["playwright@1.0.0"] = {};
  transitive.lock.snapshots["vitest@1.0.0"].dependencies.playwright = "1.0.0";
  const promoted = structuredClone(transitive);
  promoted.manifest.dependencies.playwright = "1.0.0";
  promoted.lock.importers["."].dependencies.playwright = { specifier: "1.0.0", version: "1.0.0" };
  assert.equal(applicationDependenciesOnly(sourcePair(transitive), sourcePair(promoted)), false);

  const updated = structuredClone(added);
  updated.manifest.dependencies.tsc = "2.0.0";
  updated.lock.importers["."].dependencies.tsc = { specifier: "2.0.0", version: "2.0.0" };
  updated.lock.packages["tsc@2.0.0"] = { resolution: { integrity: "sha512-ZGVm" } };
  updated.lock.snapshots["tsc@2.0.0"] = {};
  delete updated.lock.packages["tsc@1.0.0"];
  delete updated.lock.snapshots["tsc@1.0.0"];
  assert.equal(applicationDependenciesOnly(sourcePair(added), sourcePair(updated)), false);
  assert.equal(applicationDependenciesOnly(sourcePair(updated), sourcePair(added)), false);
});

test("type packages cannot introduce commands and missing metadata cannot bypass admission", () => {
  const before = dependencyFixture();
  const after = structuredClone(before);
  addDependency(after, "three");
  addDependency(after, "@types/three", "devDependencies");
  after.lock.packages["@types/three@1.0.0"].hasBin = true;
  assert.equal(applicationDependenciesOnly(sourcePair(before), sourcePair(after)), false);
  delete after.lock.packages["@types/three@1.0.0"];
  assert.equal(applicationDependenciesOnly(sourcePair(before), sourcePair(after)), false);
});

test("optional application dependencies can include their matching type package", () => {
  const before = dependencyFixture();
  const after = structuredClone(before);
  after.manifest.optionalDependencies = {};
  after.lock.importers["."].optionalDependencies = {};
  addDependency(after, "three", "optionalDependencies");
  addDependency(after, "@types/three", "devDependencies");
  assert.equal(applicationDependenciesOnly(sourcePair(before), sourcePair(after)), true);
});

test("lock-only edits cannot replace dependencies of an unchanged application CLI", () => {
  for (const group of ["dependencies", "optionalDependencies"]) {
    const before = dependencyFixture();
    before.manifest[group] ||= {};
    before.lock.importers["."][group] ||= {};
    addDependency(before, "image-size", group);
    before.lock.packages["image-size@1.0.0"].hasBin = true;
    before.lock.packages["cli-helper@1.0.0"] = { resolution: { integrity: "sha512-YWJj" } };
    before.lock.snapshots["image-size@1.0.0"].dependencies = { "cli-helper": "1.0.0" };
    before.lock.snapshots["cli-helper@1.0.0"] = {};
    const after = structuredClone(before);
    after.lock.snapshots["cli-helper@1.0.0"].dependencies = { react: "1.0.0" };
    assert.equal(applicationDependenciesOnly(sourcePair(before), sourcePair(after)), false, group);
    const ordinary = structuredClone(before);
    addDependency(ordinary, "three");
    assert.equal(applicationDependenciesOnly(sourcePair(before), sourcePair(ordinary)), true, group);
  }
});

test("rejects a removed graph freshness gate", () => {
  const files = fixture();
  const ci = YAML.parse(files[".github/workflows/ci.yml"]);
  delete ci.jobs.graphify;
  ci.jobs.checks.needs = ["verify", "quality"];
  files[".github/workflows/ci.yml"] = YAML.stringify(ci);
  assert.ok(inspect(files).includes("Missing CI job: graphify"));
  assert.ok(inspect(files).includes("Aggregate omits graphify"));
});
