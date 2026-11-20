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
/** The code takes at most this share of the card width, so a high narrow card keeps room for its text. */
const QR_WIDTH_SHARE = 0.3;

/** The side of the code for a card of this size, in design pixels. */
export function qrSide(cardWidth: number, cardHeight: number): number {
  const widest: number = Math.max(QR_MIN, Math.round(cardWidth * QR_WIDTH_SHARE));
  return Math.min(widest, Math.max(QR_MIN, Math.round(cardHeight * QR_SHARE)));
}

/**
 * The side of the code in design pixels, from the size of its card. A new side can change the card height, so the
 * hook measures again until the side stays the same. The width limit stops this growth. Each write waits for the
 * next frame.
 */
function useCardSide(plate: { readonly current: HTMLImageElement | null }): number {
  const [side, setSide] = useState<number>(QR_MIN);
  useEffect(() => {
    const card: HTMLElement | null | undefined = plate.current?.closest("article");
    if (!card) return;
    let frame = 0;
    const sizes = new ResizeObserver((): void => {
      cancelAnimationFrame(frame);
      // The offset sizes are in design pixels: the scale of the layer does not change them.
      frame = requestAnimationFrame((): void => setSide(qrSide(card.offsetWidth, card.offsetHeight)));
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
  const plate = useRef<HTMLImageElement | null>(null);
  const side: number = useCardSide(plate);
  const svg: string = renderSVG(url, {
    border: QR_BORDER,
    pixelSize: 1,
    whiteColor: QR_PLATE,
    blackColor: QR_MODULES,
  });
  return (
    <img
      className="ov-qr"
      src={`data:image/svg+xml,${encodeURIComponent(svg)}`}
      alt={t("overlay.qr.label")}
      style={{ width: side, height: side }}
      ref={plate}
      data-overlay-qr={url}
    />
  );
});
