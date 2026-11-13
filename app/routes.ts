import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("streamers", "routes/streamers.tsx"),
  route("sign-in", "routes/sign-in.tsx"),
  route("settings", "routes/settings.tsx"),
  route("admin", "routes/admin.tsx"),
  route("overlay-control", "routes/overlay-control.tsx"),
  route("privacy", "routes/privacy.tsx"),
  route("terms", "routes/terms.tsx"),
  route("ai", "routes/ai.tsx"),
  route("api/auth/*", "routes/auth.ts"),
  route("api/*", "routes/api.ts"),
  // Prevent ":handle/overlay" from matching /api/overlay.
  route("api/overlay", "routes/api.ts", { id: "api-overlay" }),
  route(":handle/overlay", "routes/overlay.tsx"),
  route(":handle", "routes/streamer.tsx"),
] satisfies RouteConfig;
