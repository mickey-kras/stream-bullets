import type { CSSProperties, ReactNode } from "react";
import { intlLocale, t } from "../../i18n";
import { MASH_DRAW } from "../../lib/mash";
import { largestRemainder } from "../../lib/percent";
import { Icon } from "../ui/icon";

const MASH_COLORS = ["mash-a", "mash-b", "mash-c", "mash-d"] as const;

/** The side colour as a CSS variable, plus a pattern class so colour is never the only cue. */
export function sideStyle(side: number): CSSProperties {
  return { "--c": `var(--${MASH_COLORS[side] ?? MASH_COLORS[0]})` } as CSSProperties;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat(intlLocale()).format(value);
}

/** A whole-number share as the language writes percentages ("29%", "29 %"). */
export function formatPercent(share: number): string {
  return new Intl.NumberFormat(intlLocale(), { style: "percent", maximumFractionDigits: 0 }).format(share / 100);
}

/** The tug-of-war bar and the per-side totals. Shares use largest-remainder rounding, so they total 100. */
export function MashBars({
  sides,
  totals,
  mySide = null,
  big = false,
}: Readonly<{ sides: string[]; totals: number[]; mySide?: number | null; big?: boolean }>): ReactNode {
  const shares: number[] = largestRemainder(totals);
  return (
    <div className={big ? "mash-bars big" : "mash-bars"} data-mash-bars>
      <div className="mash-split" aria-hidden="true">
        {sides.map((side: string, index: number) => (
          <span
            key={`${index}:${side}`}
            className={`mash-seg pat-${index}`}
            style={{ ...sideStyle(index), flexGrow: Math.max(1, totals[index] ?? 0) }}
          >
            <span className="seg-num">{index + 1}</span>
          </span>
        ))}
      </div>
      <ul className="mash-totals" aria-label={t("mash.totals")}>
        {sides.map((side: string, index: number) => (
          <li
            key={`${index}:${side}`}
            className={mySide === index ? "mash-side-total is-mine" : "mash-side-total"}
            style={sideStyle(index)}
          >
            <span className={`mash-swatch pat-${index}`} aria-hidden="true" />
            <span className="mash-label">
              {side}
              {mySide === index && !big && <span className="mine-tag"> {t("mash.yourSide")}</span>}
            </span>
            <span className="sr-only">: </span>
            <strong data-mash-total={index}>{formatCount(totals[index] ?? 0)}</strong>
            <span className="sr-only"> {t("mash.tapsSuffix")} </span>
            <span className="mash-pct" data-mash-pct={index}>
              {formatPercent(shares[index] ?? 0)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The sides alone, for an overlay with results hidden: no bar, no totals, no shares. */
export function MashSides({ sides }: Readonly<{ sides: string[] }>): ReactNode {
  return (
    <div className="mash-bars big">
      <ul className="mash-totals" aria-label={t("mash.sides")}>
        {sides.map((side: string, index: number) => (
          <li key={`${index}:${side}`} className="mash-side-total" style={sideStyle(index)}>
            <span className={`mash-swatch pat-${index}`} aria-hidden="true" />
            <span className="mash-label">{side}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The seconds-left ring. */
export function MashRing({ left, duration }: Readonly<{ left: number; duration: number }>): ReactNode {
  const style = { "--p": (left / duration) * 100 } as CSSProperties;
  return (
    <span className="mash-ring" style={style} data-mash-ring>
      <span data-mash-left>{left}</span>
      <small>{t("mash.sec")}</small>
      <span className="sr-only"> {t("mash.left")}</span>
    </span>
  );
}

/** The winner banner with its confetti burst, or "Draw" (R9). */
export function MashWinner({
  sides,
  winner,
  big = false,
}: Readonly<{ sides: string[]; winner: number; big?: boolean }>): ReactNode {
  const draw: boolean = winner === MASH_DRAW;
  const pieces: number = big ? 18 : 14;
  return (
    <div className={big ? "mash-winner big" : "mash-winner"} style={sideStyle(draw ? 0 : winner)}>
      <span className="mash-burst" aria-hidden="true">
        {Array.from({ length: draw ? 0 : pieces }, (_: unknown, index: number) => (
          <i key={index} style={{ "--i": index } as CSSProperties} />
        ))}
      </span>
      {big ? (
        <>
          <p>{draw ? t("mash.final") : t("mash.winner")}</p>
          <strong>{draw ? t("mash.draw") : sides[winner]}</strong>
        </>
      ) : (
        <>
          <Icon name="success" size={40} />
          <h3 className="mash-winner-title" tabIndex={-1}>
            <span>{draw ? t("mash.final") : t("mash.winner")}</span>{" "}
            <strong>{draw ? t("mash.draw") : sides[winner]}</strong>
          </h3>
        </>
      )}
    </div>
  );
}
