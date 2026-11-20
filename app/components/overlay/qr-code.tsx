import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { renderSVG } from "uqr";
import { t } from "../../i18n";

/** Dark modules on a light plate, so a phone reads the code on any background. The plate stays opaque. */
const QR_PLATE = "#f7edcf";
const QR_MODULES = "#0b2228";
/** The quiet zone in modules. */
const QR_BORDER = 2;
/** The side of the code: this share of the card height, and at least this many design pixels. */
const QR_SHARE = 0.22;
export const QR_MIN = 96;

/**
 * The side of the code in design pixels, from the height of its card. A new side can change the card height, so the
 * hook measures again until the side stays the same. Each write waits for the next frame.
 */
function useCardSide(plate: { readonly current: HTMLSpanElement | null }): number {
  const [side, setSide] = useState<number>(QR_MIN);
  useEffect(() => {
    const card: HTMLElement | null | undefined = plate.current?.closest("article");
    if (!card) return;
    let frame = 0;
    const sizes = new ResizeObserver((): void => {
      cancelAnimationFrame(frame);
      // offsetHeight is in design pixels: the scale of the layer does not change it.
      frame = requestAnimationFrame((): void => setSide(Math.max(QR_MIN, Math.round(card.offsetHeight * QR_SHARE))));
    });
    sizes.observe(card);
    return (): void => {
      sizes.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [plate]);
  return side;
}

/**
 * A QR code of `url` as an SVG picture, sharp at each size. Memoised, so the 1 s server clock tick does not encode
 * the same URL again.
 */
export const QrCode = memo(function QrCode({ url }: Readonly<{ url: string }>): ReactNode {
  const plate = useRef<HTMLSpanElement | null>(null);
  const side: number = useCardSide(plate);
  const svg: string = renderSVG(url, {
    border: QR_BORDER,
    pixelSize: 1,
    whiteColor: QR_PLATE,
    blackColor: QR_MODULES,
  });
  return (
    <span
      className="ov-qr"
      role="img"
      aria-label={t("overlay.qr.label")}
      style={{ width: side, height: side }}
      ref={plate}
      data-overlay-qr={url}
    >
      <img src={`data:image/svg+xml,${encodeURIComponent(svg)}`} alt="" />
    </span>
  );
});
