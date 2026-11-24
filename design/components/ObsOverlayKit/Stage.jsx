import { useLayoutEffect, useRef, useState } from "react";

// 1920×1080 design canvas scaled to fit its container (overlay-composition.tsx / use-design-scale.ts).
export function Stage({ background, children }) {
  const ref = useRef(null);
  const [scale, setScale] = useState(0.5);
  useLayoutEffect(() => {
    const el = ref.current;
    const fit = () => setScale(Math.min(el.clientWidth / 1920, el.clientHeight / 1080));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="ov-frame" ref={ref} data-background={background}>
      <div className="ov-scaler" style={{ transform: `scale(${scale})` }}>
        {background === "game" && <div className="ov-game" />}
        {children}
      </div>
    </div>
  );
}
