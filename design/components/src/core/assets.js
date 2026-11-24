// The app serves its images from /assets/. The design system keeps a copy of each one in design/assets/,
// next to the components/ folder that holds bundle.js and bundle.css. bundle.css finds its images at
// ../assets/; this finds the images that the parts put in src attributes and inline styles in the same way.
function base() {
  if (typeof document === "undefined") return "http://localhost/components/";
  const script = document.currentScript?.src;
  if (script) return script;
  const sheet = document.querySelector('link[rel="stylesheet"][href*="bundle.css"]');
  return sheet ? sheet.href : document.baseURI;
}
const from = base();

// path is relative to design/assets/, for example "Logos/stream-bullets.svg".
export function assetUrl(path) {
  return new URL(`../assets/${path}`, from).href;
}
