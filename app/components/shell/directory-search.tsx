import type { ReactNode } from "react";
import { t } from "../../i18n";
import { paths } from "../../lib/shell";
import { Icon } from "../ui/icon";

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
