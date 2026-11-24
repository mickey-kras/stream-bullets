import { assetUrl } from "./assets.js";

export { assetUrl };

export const LOGO_SRC = { full: "Logos/stream-bullets.svg", icon: "Logos/stream-bullets-icon.svg" };

// The brand images of the app (public/assets/stream-bullets*.svg).
// kind "site": the home link of the site header (SiteLogo). It shows the wordmark, and the icon on phones.
// kind "full" or "icon": the image only, for the containers that size it (.landing-logo, .sb-mark, .ideas-logo).
export function Logo({ kind = "site", href = "/", label = "Home", height, className = "", onClick }) {
  if (kind === "site")
    return (
      <a className={`brand site-logo ${className}`.trim()} href={href} aria-label={label} onClick={onClick}>
        <img className="logo-full" src={assetUrl(LOGO_SRC.full)} alt="" width="305" height="84" />
        <img className="logo-icon" src={assetUrl(LOGO_SRC.icon)} alt="" width="128" height="136" />
      </a>
    );
  const icon = kind === "icon";
  return (
    <img
      className={className || undefined}
      src={assetUrl(icon ? LOGO_SRC.icon : LOGO_SRC.full)}
      alt=""
      width={icon ? "128" : "305"}
      height={icon ? "136" : "84"}
      style={height ? { width: "auto", height } : undefined}
    />
  );
}
