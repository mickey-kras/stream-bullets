// The entry of the kit. design/build.ts builds it into WebsiteKit/kit.js.
import { createRoot } from "react-dom/client";
import { WebsiteApp } from "./WebsiteApp.jsx";

createRoot(document.getElementById("root")).render(<WebsiteApp />);
