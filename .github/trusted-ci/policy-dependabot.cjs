const { isDeepStrictEqual } = require("node:util");
const YAML = require("yaml");

const BOT = { login: "dependabot[bot]", id: 49699333, type: "Bot" };
const GROUPS = ["dependencies", "devDependencies", "optionalDependencies"];
// Scanner tool dependencies stay manual: updating them also needs a reviewed
// immutable PINNED promotion, otherwise the scanner would still run old code.
const PACKAGES = [["package.json", "pnpm-lock.yaml"]];
// Repository manifests use exact registry versions. URLs, aliases, ranges and
// local/workspace dependencies are outside automatic admission.
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ACTION = /^([\w.-]+(?:\/[\w.-]+)+)@[a-f0-9]{40}$/;
const without = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

function parseYaml(source) {
  const document = YAML.parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw document.errors[0];
  return document.toJS();
}

function dependencyVersionsOnly(before, after) {
  if (!isDeepStrictEqual(without(before, GROUPS), without(after, GROUPS))) return false;
  for (const group of GROUPS) {
    if (Object.hasOwn(before, group) !== Object.hasOwn(after, group)) return false;
    const old = before[group] || {};
    const next = after[group] || {};
    if (!isDeepStrictEqual(Object.keys(old).sort(), Object.keys(next).sort())) return false;
    for (const name of Object.keys(old)) {
      if (
        old[name] !== next[name] &&
        (typeof old[name] !== "string" ||
          !VERSION.test(old[name]) ||
          typeof next[name] !== "string" ||
          !VERSION.test(next[name]))
      )
        return false;
    }
  }
  return true;
}

function actionPinsOnly(before, after) {
  const normalize = (workflow) => {
    const copy = structuredClone(workflow);
    for (const job of Object.values(copy.jobs || {})) {
      for (const step of [job, ...(job.steps || [])]) {
        if (!Object.hasOwn(step, "uses")) continue;
        const match = typeof step.uses === "string" && step.uses.match(ACTION);
        step.uses = match ? { action: match[1], immutable: true } : { reference: step.uses, immutable: false };
      }
    }
    return copy;
  };
  return isDeepStrictEqual(normalize(parseYaml(before)), normalize(parseYaml(after)));
}

function lockControlsUnchanged(before, after, manifest) {
  if (
    !isDeepStrictEqual(
      without(before, ["packages", "snapshots", "importers"]),
      without(after, ["packages", "snapshots", "importers"]),
    )
  )
    return false;
  if (
    !isDeepStrictEqual(Object.keys(before.importers || {}), ["."]) ||
    !isDeepStrictEqual(Object.keys(after.importers || {}), ["."])
  )
    return false;
  const old = before.importers["."];
  const next = after.importers["."];
  if (!isDeepStrictEqual(without(old, GROUPS), without(next, GROUPS))) return false;
  return GROUPS.every((group) => {
    const dependencies = next[group] || {};
    if (!isDeepStrictEqual(Object.keys(dependencies).sort(), Object.keys(manifest[group] || {}).sort())) return false;
    return Object.entries(dependencies).every(
      ([name, dependency]) =>
        isDeepStrictEqual(Object.keys(dependency).sort(), ["specifier", "version"]) &&
        dependency.specifier === manifest[group][name] &&
        typeof dependency.version === "string" &&
        /^\d+\.\d+\.\d+(?:[-+(].*)?$/.test(dependency.version),
    );
  });
}

async function admittedDependabot(pull, repository, base, head, read) {
  if (
    pull.user?.id !== BOT.id ||
    pull.user?.login !== BOT.login ||
    pull.user?.type !== BOT.type ||
    pull.head.repo?.full_name !== repository ||
    !pull.head.ref?.startsWith("dependabot/")
  )
    return false;
  const changed = [...new Set([...Object.keys(base), ...Object.keys(head)])].filter(
    (name) => base[name]?.sha !== head[name]?.sha || base[name]?.mode !== head[name]?.mode,
  );
  if (!changed.length) return false;
  const allowed = new Set(PACKAGES.flat());
  for (const name of changed) {
    if (
      !base[name] ||
      !head[name] ||
      base[name].mode !== head[name].mode ||
      head[name].type !== "blob" ||
      !["100644", "100755"].includes(head[name].mode)
    )
      return false;
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(name)) {
      if (!actionPinsOnly(await read(base[name]), await read(head[name]))) return false;
    } else if (!allowed.has(name)) return false;
  }
  for (const [packagePath, lockPath] of PACKAGES) {
    if (!changed.includes(packagePath) && !changed.includes(lockPath)) continue;
    if (!base[packagePath] || !head[packagePath] || !base[lockPath] || !head[lockPath]) return false;
    const before = JSON.parse(await read(base[packagePath]));
    const after = JSON.parse(await read(head[packagePath]));
    if (!dependencyVersionsOnly(before, after)) return false;

    // Dependency graph consistency and vulnerabilities remain enforced by the
    // frozen install/audit gates. Admission freezes lockfile control metadata.
    if (!lockControlsUnchanged(parseYaml(await read(base[lockPath])), parseYaml(await read(head[lockPath])), after)) {
      return false;
    }
  }
  return true;
}

module.exports = { admittedDependabot, dependencyVersionsOnly, actionPinsOnly, lockControlsUnchanged };
