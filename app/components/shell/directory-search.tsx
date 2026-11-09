import type { ReactNode } from "react";
import { t } from "../../i18n";
import { paths } from "../../lib/shell";
import { Icon } from "../ui/icon";

/** The magnifier inside the field and the Search button, shared by every streamer search. */
export function SearchAdornments(): ReactNode {
  return (
    <>
      <span className="search-lead" aria-hidden="true">
        <Icon name="search" size={18} />
      </span>
      <button type="submit" className="search-button">
        <Icon name="search" size={18} />
        <span className="search-text">{t("streamers.search")}</span>
        <span className="sr-only"> {t("streamers.searchSuffix")}</span>
      </button>
    </>
  );
}

/** A plain search of the Streamers directory, for pages without it (the 404 page in the mockup). */
export function StreamerSearch({ id }: Readonly<{ id: string }>): ReactNode {
  return (
    <search className="search directory-search nf-search">
      <form action={paths.streamers}>
        <label className="sr-only" htmlFor={id}>
          {t("streamers.searchLabel")}
        </label>
        <input id={id} name="query" type="search" maxLength={60} placeholder={t("streamers.searchPlaceholder")} />
        <SearchAdornments />
      </form>
    </search>
  );
}
