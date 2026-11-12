const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

// Exclude candidate symlinks and tool controls from privileged scanner discovery.
// Scanners with explicit trusted configuration can use the original checkout.
function prepare(source, destination, trusted = __dirname) {
  source = fs.realpathSync(source);
  destination = path.resolve(destination);
  assert.ok(!destination.startsWith(`${source}${path.sep}`));
  assert.ok(!fs.existsSync(destination), "Scan destination must be fresh");
  fs.mkdirSync(destination, { recursive: true });
  const controls = new Set([
    ".aislop",
    ".aislopignore",
    "biome.json",
    "biome.jsonc",
    ".git",
    "node_modules",
    // Pinned Aislop resolves Ruff from these project-local tool directories.
    ".venv",
    "venv",
    ".npmrc",
    ".semgrepignore",
    ".gitignore",
  ]);
  const directive = "aislop" + "-ignore";
  const suppression = new RegExp(`(?:\\/\\/|\\/\\*+|#|<!--|\\*)\\s*${directive}(?:-[A-Za-z][\\w-]*)?(?![\\w-])`);
  const duplicateSuppression = new RegExp(
    "aislop" + "[- ]ignore(?:-next-block|-file)?\\b.*\\b(?:duplicate-block|code-quality\\/duplicate-block)\\b",
  );
  function copy(from, to) {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const input = path.join(from, entry.name);
      const output = path.join(to, entry.name);
      assert.ok(!entry.isSymbolicLink(), `Candidate symlink rejected: ${path.relative(source, input)}`);
      if (controls.has(entry.name) || /^(?:eslint\.config\.|\.eslintrc|\.eslintignore$)/.test(entry.name)) continue;
      if (entry.isDirectory()) {
        fs.mkdirSync(output);
        copy(input, output);
      } else {
        assert.ok(entry.isFile(), "Candidate must contain only regular files and directories");
        // Pinned Aislop applies suppressions. Reject inline and unanchored duplicate directives first.
        const content = fs.readFileSync(input, "utf8");
        assert.ok(
          !suppression.test(content) && !duplicateSuppression.test(content),
          `Candidate inline scanner suppression rejected: ${path.relative(source, input)}`,
        );
        if (entry.name === "package.json") {
          const pkg = JSON.parse(fs.readFileSync(input, "utf8"));
          for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
            assert.ok(!Object.hasOwn(pkg[key] || {}, "knip"), "Candidate Knip execution is not permitted");
          }
        }
        fs.copyFileSync(input, output, fs.constants.COPYFILE_EXCL);
      }
    }
  }
  copy(source, destination);
  fs.cpSync(path.join(trusted, ".aislop"), path.join(destination, ".aislop"), { recursive: true });
  fs.copyFileSync(path.join(trusted, "biome-config.json"), path.join(destination, "biome.json"));
  fs.copyFileSync(path.join(trusted, "eslint-platform.json"), path.join(destination, ".eslintrc.json"));
  fs.writeFileSync(path.join(destination, ".aislopignore"), "");
  return destination;
}
module.exports = { prepare };
if (require.main === module) prepare(process.argv[2], process.argv[3]);
