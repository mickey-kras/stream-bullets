// The entry of the kit. scripts/build-design.ts builds it into WebsiteKit/kit.js.
import { createRoot } from "react-dom/client";
import { WebsiteApp } from "./WebsiteApp.jsx";

createRoot(document.getElementById("root")).render(<WebsiteApp />);
