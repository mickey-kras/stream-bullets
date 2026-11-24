import { useRef } from "react";
// Pure hook of the app: sets --ov-scale and data-scaled on the frame (use-design-scale.ts).
import { useDesignScale } from "../../../app/components/overlay/use-design-scale.ts";

const FRAME = { w: 1920, h: 1080 };

/**
 * The design canvas of the Overlay control preview (layout-grid.tsx): the 1920 × 1080 `.ov-scaler`, scaled to the
 * frame width. The background is the transparent checkerboard or the CSS sample game of composition.css.
 */
export function Stage({ background = "checker", children }) {
  const frame = useRef(null);
  useDesignScale(frame, FRAME.w);
  return (
    <section
      className="ov-frame ov-comp-frame"
      data-orientation="horizontal"
      data-background={background}
      ref={frame}
      aria-label="Composition preview"
    >
      <div className="ov-scaler" style={{ width: FRAME.w, height: FRAME.h, "--vw": `${FRAME.w / 100}px` }}>
        {background === "game" && <div className="ov-comp-game" aria-hidden="true" />}
        {children}
      </div>
    </section>
  );
}
