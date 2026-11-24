// Writes design/site/: a page that shows the whole design system, as the Claude design system page does.
// Each preview is compiled at build time, so the page also works from file://.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { transform } from "esbuild";
import { marked } from "marked";

interface Card {
  name: string;
  group: string;
  height: number;
  width?: number;
  subtitle?: string;
  readme?: string;
}
interface Token {
  name: string;
  value: string | Record<string, string>;
  usage?: string;
}
interface TypeStyle {
  name: string;
  fontSize: string;
  lineHeight: string | number;
  fontWeight: number | string;
}
interface Tokens {
  color: { themes: { id: string; name: string }[]; tokens: Token[] };
  type: { families: Record<string, string>; groups: { name: string; family: string; styles: TypeStyle[] }[] };
  [family: string]: unknown;
}
interface AssetGroups {
  assetGroups: Record<string, { order: string[]; files: Record<string, { name: string; blob: string }> }>;
}

const escape = (text: string): string =>
  text.replace(/[&<>"]/g, (c: string) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const markdown = (text: string): string => marked(text, { async: false });
const attribute = (line: string, name: string): string | undefined =>
  line
    .match(new RegExp(`${name}=(?:"([^"]*)"|(\\d+))`))
    ?.slice(1)
    .find(Boolean);

// The themes of the app, as the data attributes that app/styles/tokens.css reads.
const themes: Record<string, string> = {
  default: "",
  "high-contrast": 'data-contrast="high"',
  "protan-deutan": 'data-cvd="pd"',
  tritan: 'data-cvd="tri"',
};

async function preview(design: string, name: string, blobs: Map<string, string>): Promise<string> {
  let html: string = await readFile(`${design}components/${name}/preview.html`, "utf8");
  html = html
    .replace(/^<!--[^\n]*-->\n?/, "")
    .replace(/<script src="https:\/\/unpkg\.com\/@babel\/standalone[^"]*"><\/script>\n?/, "");
  for (const match of html.matchAll(/<script type="text\/babel">([\s\S]*?)<\/script>/g)) {
    const { code } = await transform(match[1], { loader: "jsx", jsx: "transform" });
    html = html.replace(match[0], () => `<script>${code}</script>`);
  }
  html = html
    .replace(/(src|href)="\.\//g, `$1="../../components/${name}/`)
    .replace(/\/_blob\/([0-9a-f]{32})/g, (_m: string, id: string) => `../../${blobs.get(id) ?? `missing-asset-${id}`}`);
  const head = `<link rel="stylesheet" href="../../components/bundle.css">
<style>html,body{height:auto;min-height:100%;overflow:auto;display:block}</style>
<script>{const t=new URLSearchParams(location.search).get("theme");const a={"high-contrast":["data-contrast","high"],"protan-deutan":["data-cvd","pd"],tritan:["data-cvd","tri"]}[t];if(a)document.documentElement.setAttribute(a[0],a[1]);else document.documentElement.setAttribute("data-contrast","default")}</script>
<script src="../../components/lib/react.production.min.js"></script>
<script src="../../components/lib/react-dom.production.min.js"></script>
<script src="../../components/bundle.js"></script>`;
  return /<head>/i.test(html) ? html.replace(/<head>/i, `<head>${head}`) : `${head}${html}`;
}

export async function buildSite(design: string): Promise<void> {
  const out = `${design}site/`;
  await rm(out, { recursive: true, force: true });
  await mkdir(`${out}previews`, { recursive: true });
  const index: AssetGroups = JSON.parse(await readFile(`${design}design-system.json`, "utf8"));
  const blobs = new Map<string, string>();
  for (const [group, entry] of Object.entries(index.assetGroups))
    for (const file of Object.values(entry.files)) blobs.set(file.blob, `assets/${group}/${file.name}`);

  const cards: Card[] = [];
  for (const name of (await readdir(`${design}components`, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !["lib", "src"].includes(entry.name))
    .map((entry) => entry.name)
    .sort()) {
    const first: string = (await readFile(`${design}components/${name}/preview.html`, "utf8")).split("\n")[0];
    const readme: string | undefined = await readFile(`${design}components/${name}/README.md`, "utf8").catch(
      () => undefined,
    );
    await writeFile(`${out}previews/${name}.html`, await preview(design, name, blobs));
    cards.push({
      name,
      group: attribute(first, "group") ?? "Cover",
      height: Number(attribute(first, "height") ?? 200),
      width: attribute(first, "width") ? Number(attribute(first, "width")) : undefined,
      subtitle: attribute(first, "subtitle"),
      readme,
    });
  }

  const tokens: Tokens = JSON.parse(await readFile(`${design}tokens.json`, "utf8"));
  const themeIds: string[] = tokens.color.themes.map((theme) => theme.id);
  const value = (token: Token, theme: string): string =>
    typeof token.value === "string" ? token.value : (token.value[theme] ?? token.value[themeIds[0]]);
  const swatch = (token: Token): string =>
    `<tr><td><code>${escape(token.name)}</code></td>${themeIds
      .map((theme: string) => {
        const v: string = value(token, theme);
        const css: string = v.startsWith("{") ? `var(--${v.slice(1, -1)})` : v;
        return `<td><span class="chip" style="background:${escape(css)}"></span><code>${escape(v)}</code></td>`;
      })
      .join("")}<td>${markdown(token.usage ?? "")}</td></tr>`;
  const scale = (family: string): string => {
    const list = (tokens[family] as { tokens?: Token[] } | undefined)?.tokens ?? [];
    return list.length
      ? `<h3>${escape(family[0].toUpperCase() + family.slice(1))}</h3><table><tbody>${list
          .map(
            (t: Token) =>
              `<tr><td><code>${escape(t.name)}</code></td><td><code>${escape(value(t, themeIds[0]))}</code></td><td>${markdown(t.usage ?? "")}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : "";
  };
  const type: string = tokens.type.groups
    .flatMap((group) => group.styles.map((style) => ({ group, style })))
    .map(
      ({ group, style }) =>
        `<div class="type"><span class="meta">${escape(group.name)} · ${escape(style.name)} · ${escape(style.fontSize)} / ${escape(String(style.lineHeight))} · ${escape(String(style.fontWeight))}</span><span style="font-family:${escape(tokens.type.families[group.family] ?? "inherit")};font-size:${escape(style.fontSize)};line-height:${escape(String(style.lineHeight))};font-weight:${escape(String(style.fontWeight))}">Suggest topics. Vote. Shape the stream.</span></div>`,
    )
    .join("");

  const order: string[] = [
    "Cover",
    "Brand",
    "Foundations",
    "Core",
    "Forms",
    "Feedback",
    "Shell",
    "Topic board",
    "Polls",
    "Overlay",
    "UI kits",
  ];
  const rank = (group: string): number => (order.includes(group) ? order.indexOf(group) : order.length);
  const groups: string[] = [...new Set(cards.map((card) => card.group))].sort(
    (a: string, b: string) => rank(a) - rank(b),
  );
  const componentHtml: string = groups
    .map(
      (group: string) =>
        `<h3 id="group-${escape(group)}">${escape(group)}</h3>${cards
          .filter((card) => card.group === group)
          .map(
            (card) =>
              `<article class="card" id="${escape(card.name)}"><div class="card-head"><h4>${escape(card.name)}</h4>${card.subtitle ? `<p class="meta">${escape(card.subtitle)}</p>` : ""}</div><div class="frame" data-width="${card.width ?? ""}" style="--h:${card.height}px"><iframe loading="lazy" title="${escape(card.name)} preview" src="previews/${escape(card.name)}.html"></iframe></div>${card.readme ? `<div class="readme">${markdown(card.readme)}</div>` : ""}</article>`,
          )
          .join("")}`,
    )
    .join("");
  const assetHtml: string = (
    await Promise.all(
      Object.entries(index.assetGroups).map(async ([group, entry]) => {
        const readme: string = await readFile(`${design}assets/${group}/README.md`, "utf8").catch(() => "");
        return `<h3>${escape(group)}</h3>${markdown(readme)}<div class="assets">${entry.order
          .map(
            (file: string) =>
              `<figure><img loading="lazy" src="../assets/${escape(group)}/${escape(file)}" alt=""><figcaption><code>${escape(file)}</code></figcaption></figure>`,
          )
          .join("")}</div>`;
      }),
    )
  ).join("");

  const page = `<!doctype html>
<html lang="en" data-contrast="default"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>StreamBullets design system</title>
<link rel="stylesheet" href="../components/bundle.css">
<style>
html,body{height:auto;overflow:auto;display:block}
body{margin:0}
.ds{display:grid;grid-template-columns:240px minmax(0,1fr);max-width:1440px;margin:0 auto}
.ds nav{position:sticky;top:0;align-self:start;max-height:100vh;overflow:auto;padding:var(--space-6) var(--space-4);border-right:1px solid var(--line)}
.ds nav a{display:block;padding:6px 0;color:var(--muted);text-decoration:none}
.ds nav a:hover{color:var(--gold)}
.ds .ds-main{padding:var(--space-8) var(--space-6);min-width:0}
.ds h1,.ds h2,.ds h3{font-family:var(--heading);text-transform:uppercase;color:var(--gold);letter-spacing:.02em}
.ds h2{margin-top:var(--space-12);padding-top:var(--space-4);border-top:1px solid var(--line)}
.ds table{width:100%;border-collapse:collapse;margin:var(--space-4) 0}
.ds td,.ds th{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid var(--line)}
.ds td p{margin:0}
.ds code{font-size:.875rem;color:var(--cream)}
.ds .chip{display:inline-block;width:20px;height:20px;margin-right:8px;vertical-align:middle;border:1px solid var(--line);border-radius:var(--radius-control)}
.ds .meta{color:var(--muted);font-size:.875rem}
.ds .type{display:grid;gap:4px;padding:var(--space-3) 0;border-bottom:1px solid var(--line)}
.ds .card{margin:var(--space-6) 0;padding:var(--space-4);border:1px solid var(--line);border-radius:var(--radius-panel);background:var(--card)}
.ds .card h4{margin:0;font:600 1.25rem/1.2 var(--heading);text-transform:uppercase;color:var(--cream)}
.ds .frame{position:relative;height:var(--h);margin:var(--space-3) 0;overflow:hidden;border:1px solid var(--line);border-radius:var(--radius-control)}
.ds .frame iframe{border:0;width:100%;height:100%;transform-origin:0 0;display:block}
.ds .assets{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:var(--space-4)}
.ds figure{margin:0}.ds figure img{width:100%;height:auto;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--ink)}
@media (max-width:800px){.ds{grid-template-columns:1fr}.ds nav{position:static;max-height:none;border-right:0;border-bottom:1px solid var(--line)}}
</style></head><body><div class="ds">
<nav aria-label="Design system"><a href="#brand">Brand book</a><a href="#colors">Colors</a><a href="#type">Type</a><a href="#scales">Spacing and shape</a><a href="#components">Components</a>${groups.map((g: string) => `<a href="#group-${escape(g)}">· ${escape(g)}</a>`).join("")}<a href="#assets">Assets</a>
<p><label class="meta" for="theme">Preview theme</label><br><select id="theme">${tokens.color.themes.map((t) => `<option value="${escape(t.id)}">${escape(t.name)}</option>`).join("")}</select></p></nav>
<div class="ds-main">
<p class="meta">Generated by design/build.ts. The CSS of each preview is the CSS of the app.</p>
<section id="brand">${markdown(await readFile(`${design}README.md`, "utf8"))}</section>
<section id="colors"><h2>Colors</h2><table><thead><tr><th>Token</th>${tokens.color.themes.map((t) => `<th>${escape(t.name)}</th>`).join("")}<th>Usage</th></tr></thead><tbody>${tokens.color.tokens.map(swatch).join("")}</tbody></table></section>
<section id="type"><h2>Type</h2>${type}</section>
<section id="scales"><h2>Spacing and shape</h2>${["spacing", "radius", "size", "shadow", "duration"].map(scale).join("")}</section>
<section id="components"><h2>Components</h2>${componentHtml}</section>
<section id="assets"><h2>Assets</h2>${assetHtml}</section>
</div></div>
<script>
const fit=()=>document.querySelectorAll(".frame").forEach(f=>{const w=Number(f.dataset.width),i=f.firstElementChild;if(!w)return;const s=Math.min(1,f.clientWidth/w);i.style.width=w+"px";i.style.height=(f.clientHeight/s)+"px";i.style.transform="scale("+s+")"});
addEventListener("resize",fit);fit();
const themes=${JSON.stringify(themes)};
document.getElementById("theme").addEventListener("change",e=>{const t=e.target.value,root=document.documentElement;root.removeAttribute("data-cvd");root.setAttribute("data-contrast","default");const m=(themes[t]||"").match(/(\\S+)="(\\S+)"/);if(m)root.setAttribute(m[1],m[2]);document.querySelectorAll("iframe").forEach(i=>{i.src=i.src.split("?")[0]+(t==="default"?"":"?theme="+t)})});
</script></body></html>`;
  await writeFile(`${out}index.html`, page);
}
