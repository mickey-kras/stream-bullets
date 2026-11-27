import type { ReactNode } from "react";
import { Link } from "react-router";
import { t, type MessageId } from "../../i18n";
import { toolsPath, toolsViews, type ToolsView } from "../../lib/shell";
import { Icon, type IconName } from "../ui/icon";

/** The name and the icon of each section. A phone shows the icon in the tab and the name as the title. */
const sections: Readonly<Record<ToolsView, Readonly<{ label: MessageId; icon: IconName }>>> = {
  live: { label: "tools.tab.live", icon: "live" },
  overlay: { label: "tools.tab.overlay", icon: "layers" },
  channels: { label: "tools.tab.channels", icon: "channels" },
};

/**
 * The head of Streamer tools: the links to its sections and the title. On a desktop, the title is the name of the
 * page and the sections are text tabs below it. On a phone, the sections are icon tabs in a line below the site
 * header, and the title is the name of the open section. The styles show one of the two names, so the page has one
 * `h1` with one name at each width.
 */
export function ToolsHead({ view }: Readonly<{ view: ToolsView }>): ReactNode {
  return (
    <div className="tools-head">
      <nav className="tabs status-tabs tools-tabs" aria-label={t("tools.sections")}>
        {toolsViews.map((item: ToolsView) => {
          const label: string = t(sections[item].label);
          return (
            <Link
              key={item}
              to={toolsPath(item)}
              className={item === view ? "active" : ""}
              aria-label={label}
              title={label}
              aria-current={item === view ? "page" : undefined}
              preventScrollReset
            >
              <Icon name={sections[item].icon} size={24} />
              <span className="tools-tab-label">{label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="ov-head">
        <div>
          <span className="eyebrow tools-page-name">{t("tools.eyebrow")}</span>
          <h1>
            <span className="tools-page-name">{t("tools.title")}</span>
            <span className="tools-section-name">{t(sections[view].label)}</span>
          </h1>
        </div>
      </div>
    </div>
  );
}
