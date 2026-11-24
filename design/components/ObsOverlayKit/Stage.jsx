// 1920×1080 design canvas scaled to fit its container (overlay-composition.tsx / use-design-scale.ts).
function Stage({ background, children }) {
  const ref = React.useRef(null);
  const [scale, setScale] = React.useState(0.5);
  React.useLayoutEffect(() => {
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
window.Stage = Stage;
