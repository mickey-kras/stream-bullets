import type { ReactNode } from "react";
import { Link } from "react-router";
import { t, type MessageId } from "../../i18n";
import { toolsPath, toolsViews, type ToolsView } from "../../lib/shell";

const viewLabel: Record<ToolsView, MessageId> = {
  live: "tools.tab.live",
  overlay: "tools.tab.overlay",
  channels: "tools.tab.channels",
};

/** The head of Streamer tools: the title of the page and the links to its sections. */
export function ToolsHead({ view }: Readonly<{ view: ToolsView }>): ReactNode {
  return (
    <>
      <div className="ov-head">
        <div>
          <span className="eyebrow">{t("tools.eyebrow")}</span>
          <h1>{t("tools.title")}</h1>
        </div>
      </div>
      <nav className="tabs status-tabs tools-tabs" aria-label={t("tools.sections")}>
        {toolsViews.map((item: ToolsView) => (
          <Link
            key={item}
            to={toolsPath(item)}
            className={item === view ? "active" : ""}
            aria-current={item === view ? "page" : undefined}
            preventScrollReset
          >
            {t(viewLabel[item])}
          </Link>
        ))}
      </nav>
    </>
  );
}
