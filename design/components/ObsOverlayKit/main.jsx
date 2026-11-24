// The entry of the kit. design/build.ts builds it into ObsOverlayKit/kit.js.
import { createRoot } from "react-dom/client";
import { OverlayApp } from "./OverlayApp.jsx";

createRoot(document.getElementById("root")).render(<OverlayApp />);
