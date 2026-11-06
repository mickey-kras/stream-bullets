import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { t } from "../../i18n";
import { Icon, type IconName } from "../ui/icon";
import { IconButton } from "../ui/icon-button";
import {
  cropGeometry,
  initialCrop,
  MAX_ZOOM,
  MIN_ZOOM,
  OUTPUT_SIZE,
  panBy,
  settle,
  zoomTo,
  type CropGeometry,
  type CropState,
} from "./crop";

export interface CropperHandle {
  /** The circle's square at 512 × 512, as a JPEG ready for `PUT /api/images/{avatar|logo}`. */
  exportBlob: () => Promise<Blob>;
}

const NUDGE: readonly (readonly [string, IconName, number, number] | null)[] = [
  null,
  ["crop.moveUp", "chevron-up", 0, -10],
  null,
  ["crop.moveLeft", "chevron-left", -10, 0],
  ["crop.resetPosition", "reset", 0, 0],
  ["crop.moveRight", "chevron-right", 10, 0],
  null,
  ["crop.moveDown", "chevron-down", 0, 10],
  null,
];

function coarsePointer(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

/**
 * The circular cropper (item 13): drag to pan, zoom 1–4× with the slider, the ± buttons, the wheel or a
 * pinch; arrow keys move (Shift for bigger steps) and + / − zoom. Live previews at comment (48px) and header
 * (32px) size. "Fine-tune position" buttons are open by default except on touch devices.
 */
export const Cropper = forwardRef<CropperHandle, { src: string; kind: "profile" | "page"; onError: (message: string) => void }>(
  function Cropper({ src, kind, onError }, ref): ReactNode {
    const stage = useRef<HTMLDivElement | null>(null);
    const image = useRef<HTMLImageElement | null>(null);
    const previews = useRef<(HTMLCanvasElement | null)[]>([]);
    const pointers = useRef<Map<number, [number, number]>>(new Map());
    const pinch = useRef<number>(0);
    const [size, setSize] = useState<number>(0);
    const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
    const [crop, setCrop] = useState<CropState>(initialCrop);
    const [nudgeOpen, setNudgeOpen] = useState<boolean>(true);

    useEffect(() => setNudgeOpen(!coarsePointer()), []);

    useEffect(() => {
      const element = stage.current;
      if (!element) return;
      const observer = new ResizeObserver(() => setSize(element.clientWidth));
      observer.observe(element);
      setSize(element.clientWidth);
      // The wheel zooms; React's wheel listener is passive, so this one is added by hand.
      const wheel = (event: WheelEvent): void => {
        event.preventDefault();
        setCrop((current: CropState) => zoomTo(current, current.zoom * Math.exp(-event.deltaY * 0.0015)));
      };
      element.addEventListener("wheel", wheel, { passive: false });
      return () => {
        observer.disconnect();
        element.removeEventListener("wheel", wheel);
      };
    }, []);

    const geometry: CropGeometry | null = natural && size ? cropGeometry(size, natural, crop) : null;

    useEffect(() => {
      const img = image.current;
      if (!geometry || !img) return;
      for (const canvas of previews.current) {
        const context = canvas?.getContext("2d");
        if (!canvas || !context) continue;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(img, geometry.sx, geometry.sy, geometry.side, geometry.side, 0, 0, canvas.width, canvas.height);
      }
    });

    useImperativeHandle(
      ref,
      () => ({
        exportBlob: (): Promise<Blob> =>
          new Promise<Blob>((resolve, reject) => {
            const img = image.current;
            if (!img || !natural || !size) {
              reject(new Error(t("crop.notReady")));
              return;
            }
            const g: CropGeometry = cropGeometry(size, natural, crop);
            const canvas: HTMLCanvasElement = document.createElement("canvas");
            canvas.width = OUTPUT_SIZE;
            canvas.height = OUTPUT_SIZE;
            const context = canvas.getContext("2d");
            if (!context) {
              reject(new Error(t("crop.notReady")));
              return;
            }
            context.drawImage(img, g.sx, g.sy, g.side, g.side, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
            canvas.toBlob(
              (blob: Blob | null) => (blob ? resolve(blob) : reject(new Error(t("crop.notReady")))),
              "image/jpeg",
              0.9,
            );
          }),
      }),
      [crop, natural, size],
    );

    function move(dx: number, dy: number): void {
      setCrop((current: CropState) => (natural && size ? settle(size, natural, panBy(current, dx, dy)) : current));
    }

    function zoom(value: number): void {
      setCrop((current: CropState) => zoomTo(current, value));
    }

    function pointerMove(event: PointerEvent<HTMLDivElement>): void {
      const previous = pointers.current.get(event.pointerId);
      if (!previous) return;
      pointers.current.set(event.pointerId, [event.clientX, event.clientY]);
      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()];
        const distance: number = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch.current) {
          const ratio: number = distance / pinch.current;
          setCrop((current: CropState) => zoomTo(current, current.zoom * ratio));
        }
        pinch.current = distance;
        return;
      }
      move(event.clientX - previous[0], event.clientY - previous[1]);
    }

    function pointerEnd(event: PointerEvent<HTMLDivElement>): void {
      pointers.current.delete(event.pointerId);
      pinch.current = 0;
    }

    function keyDown(event: KeyboardEvent<HTMLDivElement>): void {
      const step: number = event.shiftKey ? 40 : 10;
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const delta = moves[event.key];
      if (delta) {
        event.preventDefault();
        move(delta[0], delta[1]);
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoom(crop.zoom + 0.1);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoom(crop.zoom - 0.1);
      }
    }

    const page: boolean = kind === "page";
    return (
      <>
        <div className="crop-layout">
          <div
            className="crop-stage"
            ref={stage}
            tabIndex={0}
            role="group"
            aria-label={t("crop.position")}
            aria-describedby="crop-keys"
            onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
              event.currentTarget.setPointerCapture?.(event.pointerId);
              pointers.current.set(event.pointerId, [event.clientX, event.clientY]);
              pinch.current = 0;
            }}
            onPointerMove={pointerMove}
            onPointerUp={pointerEnd}
            onPointerCancel={pointerEnd}
            onKeyDown={keyDown}
          >
            <img
              ref={image}
              className="crop-img"
              src={src}
              alt=""
              draggable={false}
              onLoad={(event) => {
                const img = event.currentTarget;
                setNatural({ width: img.naturalWidth, height: img.naturalHeight });
                setCrop(initialCrop);
              }}
              onError={() => onError(t("crop.unreadable"))}
              style={
                geometry
                  ? {
                      width: `${geometry.width}px`,
                      height: `${geometry.height}px`,
                      left: `${(size - geometry.width) / 2 + geometry.x}px`,
                      top: `${(size - geometry.height) / 2 + geometry.y}px`,
                    }
                  : { visibility: "hidden" }
              }
            />
            <span className="crop-mask" aria-hidden="true" />
          </div>
          <div className="crop-side">
            <p className="crop-side-title">{page ? t("crop.previewPage") : t("crop.previewProfile")}</p>
            <div className="crop-previews">
              <figure>
                <canvas
                  className="crop-preview"
                  width={96}
                  height={96}
                  data-size="48"
                  role="img"
                  aria-label={t("crop.previewLarge")}
                  ref={(element: HTMLCanvasElement | null) => {
                    previews.current[0] = element;
                  }}
                />
                <figcaption>{page ? t("crop.pageHeader") : t("crop.comments")}</figcaption>
              </figure>
              <figure>
                <canvas
                  className="crop-preview"
                  width={64}
                  height={64}
                  data-size="32"
                  role="img"
                  aria-label={t("crop.previewSmall")}
                  ref={(element: HTMLCanvasElement | null) => {
                    previews.current[1] = element;
                  }}
                />
                <figcaption>{page ? t("crop.streamersList") : t("crop.header")}</figcaption>
              </figure>
            </div>
          </div>
        </div>
        <p className="sr-only" id="crop-keys">
          {t("crop.keys")}
        </p>
        <details
          className="nudge-wrap"
          open={nudgeOpen}
          onToggle={(event) => setNudgeOpen(event.currentTarget.open)}
        >
          <summary>{t("crop.fineTune")}</summary>
          <div className="nudge-pad" role="group" aria-label={t("crop.movePicture")}>
            {NUDGE.map((cell, index: number) =>
              cell ? (
                <IconButton
                  key={cell[0]}
                  className="nudge"
                  label={t(cell[0] as "crop.moveUp")}
                  icon={cell[1]}
                  iconSize={18}
                  onClick={() => (cell[2] || cell[3] ? move(cell[2], cell[3]) : setCrop({ ...crop, x: 0, y: 0 }))}
                />
              ) : (
                // Empty corners of the 3 × 3 pad.
                <span key={`gap-${index}`} aria-hidden="true" />
              ),
            )}
          </div>
        </details>
        <div className="crop-zoom">
          <IconButton
            className="crop-step"
            label={t("crop.zoomOut")}
            icon="zoom-out"
            iconSize={18}
            onClick={() => zoom(crop.zoom - 0.25)}
          />
          <label className="crop-zoom-label">
            <span>{t("crop.zoom")}</span>
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.01}
              value={crop.zoom}
              aria-valuetext={t("crop.zoomValue", { zoom: crop.zoom.toFixed(1) })}
              onChange={(event) => zoom(Number(event.currentTarget.value))}
            />
          </label>
          <IconButton
            className="crop-step"
            label={t("crop.zoomIn")}
            icon="zoom-in"
            iconSize={18}
            onClick={() => zoom(crop.zoom + 0.25)}
          />
          <button type="button" className="text-button" onClick={() => setCrop(initialCrop)}>
            <Icon name="reset" size={16} />
            {t("crop.reset")}
          </button>
        </div>
      </>
    );
  },
);
