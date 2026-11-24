/**
 * Builds the design system in design/components from its sources.
 *
 *   node scripts/build-design.ts
 *
 * It writes components/bundle.js, WebsiteKit/kit.js and ObsOverlayKit/kit.js. Git does not track them.
 * The pages that load them supply React 18 as the globals React and ReactDOM. The kits read the parts
 * from the bundle namespace, so a page loads bundle.js before a kit.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build, type BuildOptions, type Plugin } from "esbuild";

const root: string = fileURLToPath(new URL("../design/components/", import.meta.url));
const namespace = "StreamBulletsDesignSystem_e1d9fa";

const pageModules: Record<string, string> = {
  react: "module.exports = window.React;",
  "react-dom": "module.exports = window.ReactDOM;",
  "react-dom/client": "module.exports = window.ReactDOM;",
  // The React 18 UMD build has no JSX runtime. The sources and Radix compile to calls of this one.
  "react/jsx-runtime": [
    "const React = window.React;",
    "export const Fragment = React.Fragment;",
    "export const jsx = (type, props, key) => React.createElement(type, key === undefined ? props : { ...props, key });",
    "export const jsxs = jsx;",
  ].join("\n"),
};

// Resolves the listed imports to globals of the page instead of bundling them.
function pageGlobals(modules: Record<string, string>): Plugin {
  const filter = new RegExp(
    `^(${Object.keys(modules)
      .map((name: string) => name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
      .join("|")})$`,
  );
  return {
    name: "page-globals",
    setup(builder) {
      builder.onResolve({ filter }, (args) => ({ path: args.path, namespace: "page-global" }));
      builder.onLoad({ filter: /.*/, namespace: "page-global" }, (args) => ({
        contents: modules[args.path],
        loader: "js",
      }));
    },
  };
}

const common: BuildOptions = {
  bundle: true,
  format: "iife",
  target: "es2020",
  charset: "utf8",
  jsx: "automatic",
  logLevel: "warning",
};

// The manifest line lists one part for each module of src/index.js, as the Claude design system expects.
const index: string = await readFile(`${root}src/index.js`, "utf8");
const components: { name: string }[] = [...index.matchAll(/from "\.\/\w+\/(\w+)\.jsx"/g)].map(
  (match: RegExpExecArray) => ({ name: match[1] }),
);

await build({
  ...common,
  entryPoints: [`${root}src/index.js`],
  outfile: `${root}bundle.js`,
  globalName: namespace,
  banner: { js: `/* @ds-bundle: ${JSON.stringify({ format: 4, namespace, components })} */` },
  plugins: [pageGlobals(pageModules)],
});

for (const kit of ["WebsiteKit", "ObsOverlayKit"]) {
  await build({
    ...common,
    entryPoints: [`${root}${kit}/main.jsx`],
    outfile: `${root}${kit}/kit.js`,
    plugins: [pageGlobals({ ...pageModules, "../src/index.js": `module.exports = window.${namespace};` })],
  });
}
