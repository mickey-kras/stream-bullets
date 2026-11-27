import type { ReactNode } from "react";
import type { MetaArgs } from "react-router";
import { CommandDemo } from "../components/commands/command-demo";
import { DEMOS } from "../components/commands/demos";
import { BackLink } from "../components/shell/back-link";
import { SiteHeader } from "../components/shell/site-header";
import { type MessageId, t } from "../i18n";
import { COMMAND_ALIASES, COMMANDS, type Command } from "../lib/playground/crowd";
import { canonicalMeta } from "../lib/seo";
import { paths } from "../lib/shell";

export { RouteErrorBoundary as ErrorBoundary } from "../components/route-error";

export function meta({ matches }: MetaArgs) {
  return [
    ...canonicalMeta(matches, paths.commands),
    { title: `${t("commands.title")} · StreamBullets` },
    { name: "description", content: t("commands.lead") },
  ];
}

/** The other words of a command, as viewers type them. */
function aliases(command: Command): string[] {
  return Object.entries(COMMAND_ALIASES).flatMap(([word, name]): string[] => (name === command ? [`!${word}`] : []));
}

function CommandRow({ command, names }: Readonly<{ command: Command; names: readonly [string, string] }>): ReactNode {
  const other: string[] = aliases(command);
  const lines: string[] = DEMOS[command].lines.map(([, text]): string => text);
  return (
    <li className="command-row" id={command}>
      <div className="command-text">
        <h2>
          <code>!{command}</code>
        </h2>
        <p>{t(`commands.do.${command}` as MessageId)}</p>
        <p className="command-lines">
          {lines.map((line: string) => (
            <code key={line}>{line}</code>
          ))}
        </p>
        {other.length > 0 && <p className="muted">{t("commands.also", { words: other.join(", ") })}</p>}
      </div>
      <CommandDemo demo={DEMOS[command]} names={names} />
    </li>
  );
}

/** The page for viewers: each chat command of the character playground, with a demo that runs the real rules. */
export default function CommandsPage(): ReactNode {
  const names: readonly [string, string] = [t("commands.you"), t("commands.friend")];
  return (
    <>
      <SiteHeader />
      <main className="page-panel" id="main-content">
        <div className="page-column commands-page">
          <BackLink />
          <span className="eyebrow">{t("commands.eyebrow")}</span>
          <h1>{t("commands.title")}</h1>
          <p className="lead">{t("commands.lead")}</p>
          <p>{t("commands.rules")}</p>
          <ul className="command-list">
            {COMMANDS.map((command: Command) => (
              <CommandRow key={command} command={command} names={names} />
            ))}
          </ul>
        </div>
      </main>
    </>
  );
}
