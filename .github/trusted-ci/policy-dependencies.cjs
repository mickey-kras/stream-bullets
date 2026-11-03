const { isDeepStrictEqual } = require("node:util");
const YAML = require("yaml");
const { lockControlsUnchanged } = require("./policy-dependabot.cjs");

const DEPENDENCY_FILES = ["package.json", "pnpm-lock.yaml"];
const GROUPS = ["dependencies", "devDependencies", "optionalDependencies"];
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const without = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
function typePackage(name, manifest) {
  if (!name.startsWith("@types/")) return false;
  const dependency = name
    .slice(7)
    .replace("__", "/")
    .replace(/^([^/]+\/)/, "@$1");
  return ["dependencies", "optionalDependencies"].some((group) => Object.hasOwn(manifest[group] || {}, dependency));
}

function parseLock(source) {
  const document = YAML.parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw document.errors[0];
  return document.toJS();
}

function applicationDependenciesOnly(beforeSources, afterSources) {
  const before = JSON.parse(beforeSources["package.json"]);
  const after = JSON.parse(afterSources["package.json"]);
  if (!isDeepStrictEqual(without(before, GROUPS), without(after, GROUPS))) return false;
  const oldLock = parseLock(beforeSources["pnpm-lock.yaml"]);
  const nextLock = parseLock(afterSources["pnpm-lock.yaml"]);
  const protectedRoots = GROUPS.flatMap((group) =>
    Object.entries(before[group] || {})
      .filter(
        ([name, version]) =>
          (group === "devDependencies" && !typePackage(name, before)) ||
          oldLock.packages?.[`${name}@${version}`]?.hasBin === true,
      )
      .map(([name]) => [group, name]),
  );
  const protectedNames = new Set(protectedRoots.map(([, name]) => name));
  for (const group of GROUPS) {
    const old = before[group] || {};
    const next = after[group] || {};
    for (const name of new Set([...Object.keys(old), ...Object.keys(next)])) {
      if (old[name] === next[name]) continue;
      if (
        protectedNames.has(name) ||
        (group === "devDependencies" && !typePackage(name, before) && !typePackage(name, after))
      )
        return false;
      if (
        [old[name], next[name]].some(
          (version) => version !== undefined && (typeof version !== "string" || !VERSION.test(version)),
        )
      )
        return false;
      for (const [version, lock] of [
        [old[name], oldLock],
        [next[name], nextLock],
      ]) {
        if (version === undefined) continue;
        const metadata = lock.packages?.[`${name}@${version}`];
        if (!metadata || (metadata.hasBin !== undefined && metadata.hasBin !== false)) return false;
      }
    }
  }
  if (!lockControlsUnchanged(oldLock, nextLock, after)) return false;
  for (const group of GROUPS) {
    if (
      !Object.values(nextLock.importers["."][group] || {}).every(
        (item) => item.version.split("(")[0] === item.specifier,
      )
    )
      return false;
  }
  const pending = [];
  for (const [group, name] of protectedRoots) {
    const old = oldLock.importers["."][group]?.[name];
    if (!old || !isDeepStrictEqual(old, nextLock.importers["."][group]?.[name])) return false;
    pending.push(`${name}@${old.version}`);
  }
  const visited = new Set();
  while (pending.length) {
    const key = pending.pop();
    if (visited.has(key)) continue;
    visited.add(key);
    const metadata = key.split("(")[0];
    const snapshot = oldLock.snapshots?.[key];
    if (
      !snapshot ||
      !oldLock.packages?.[metadata] ||
      !isDeepStrictEqual(snapshot, nextLock.snapshots?.[key]) ||
      !isDeepStrictEqual(oldLock.packages[metadata], nextLock.packages?.[metadata])
    )
      return false;
    for (const group of ["dependencies", "optionalDependencies"]) {
      for (const [name, version] of Object.entries(snapshot[group] || {})) pending.push(`${name}@${version}`);
    }
  }
  // Existing registry identities must retain their integrity and package metadata.
  return Object.entries(oldLock.packages || {}).every(
    ([name, value]) => !Object.hasOwn(nextLock.packages, name) || isDeepStrictEqual(value, nextLock.packages[name]),
  );
}

module.exports = { DEPENDENCY_FILES, applicationDependenciesOnly };
