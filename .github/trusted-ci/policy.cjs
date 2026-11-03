const { readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const YAML = require("yaml");
const { DEPENDENCY_FILES, applicationDependenciesOnly } = require("./policy-dependencies.cjs");

// Treat every gate input as policy, including additions and package/tool configuration.
function isPolicyPath(name) {
  return (
    /^(?:\.github|\.vale|scripts)\//.test(name) ||
    /^\.[^/]+$/.test(name) ||
    /^[^/]*(?:config|lock)[^/]*$/.test(name) ||
    [
      "package.json",
      "pnpm-workspace.yaml",
      ".npmrc",
      ".pnpmfile.cjs",
      ".ste.yml",
      ".vale.ini",
      "sonar-project.properties",
      ".gitleaks.toml",
      ".gitleaksignore",
      ".semgrep.yml",
      ".trivyignore",
      ".trivy.yaml",
      ".gitmodules",
      ".gitattributes",
    ].includes(name)
  );
}

// Only inert documentation can accompany policy changes. Unknown files count as
// application inputs so executable additions cannot hide in a new directory.
function isApplicationPath(name) {
  if (isPolicyPath(name)) return false;
  if (/^(app|worker|db|drizzle|tests)\//.test(name)) return true;
  return (
    !/\.(?:md|markdown|rst|txt)$/i.test(name) &&
    !/^(?:[^/]+\/)*(?:LICENSE|LICENCE|COPYING|NOTICE)(?:\.[^/]*)?$/i.test(name)
  );
}

function inspect(workflows) {
  const failures = [];
  for (const [filename, source] of Object.entries(workflows)) {
    const document = YAML.parseDocument(source, { uniqueKeys: true });
    if (document.errors.length) throw document.errors[0];
    const workflow = document.toJS();
    for (const [id, job] of Object.entries(workflow.jobs || {})) {
      for (const step of [job, ...(job.steps || [])]) {
        if (Object.hasOwn(step, "continue-on-error")) failures.push(`${filename}/${id}: ignored failures`);
        if (step.uses && !step.uses.startsWith("./") && !/^[\w.-]+(?:\/[\w.-]+)+@[a-f0-9]{40}$/.test(step.uses)) {
          failures.push(`${filename}/${id}: unpinned action`);
        }
      }
    }
  }
  const ci = YAML.parse(workflows[".github/workflows/ci.yml"] || "");
  const required = ["verify", "quality", "checks", "sonar", "deploy"];
  for (const name of required) if (!ci?.jobs?.[name]) failures.push(`Missing CI job: ${name}`);
  if (ci?.jobs?.checks?.if !== "always()") failures.push("Aggregate must run after failures");
  for (const name of ["verify", "quality"]) {
    if (!ci?.jobs?.checks?.needs?.includes(name)) failures.push(`Aggregate omits ${name}`);
  }
  for (const name of ["checks", "sonar"]) {
    if (!ci?.jobs?.deploy?.needs?.includes(name)) failures.push(`Deployment omits ${name}`);
  }
  const quality = YAML.parse(workflows[".github/workflows/quality.yml"] || "");
  for (const name of ["policy", "security", "aislop", "codeql", "docs", "branch", "dependencies"]) {
    if (!quality?.jobs?.[name]) failures.push(`Missing quality job: ${name}`);
  }
  return failures;
}

function run(directory) {
  const git = (...args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  const files = git("ls-files", "-z").split("\0").filter(Boolean);
  const workflows = Object.fromEntries(
    files
      .filter((name) => /^\.github\/workflows\/.*\.ya?ml$/.test(name))
      .map((name) => [name, readFileSync(path.join(directory, name), "utf8")]),
  );
  const failures = inspect(workflows);
  if (process.env.BASE_SHA) {
    if (!/^[a-f0-9]{40}$/.test(process.env.BASE_SHA)) throw new Error("Invalid base revision");
    const changed = git("diff", "--name-only", "-z", process.env.BASE_SHA, "HEAD").split("\0").filter(Boolean);
    let dependencyOnly = false;
    if (changed.some((name) => DEPENDENCY_FILES.includes(name))) {
      const sources = (ref) =>
        Object.fromEntries(DEPENDENCY_FILES.map((name) => [name, git("show", `${ref}:${name}`)]));
      dependencyOnly = applicationDependenciesOnly(sources(process.env.BASE_SHA), sources("HEAD"));
    }
    if (
      changed.some((name) => isPolicyPath(name) && !(dependencyOnly && DEPENDENCY_FILES.includes(name))) &&
      changed.some(isApplicationPath)
    )
      failures.push("Separate CI policy changes from application changes");
  }
  if (failures.length) throw new Error(failures.join("\n"));
}
module.exports = { inspect, isPolicyPath, isApplicationPath };
if (require.main === module) run(process.argv[2]);
