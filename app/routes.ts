import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("streamers", "routes/streamers.tsx"),
  route("sign-in", "routes/sign-in.tsx"),
  route("settings", "routes/settings.tsx"),
  route("notifications", "routes/notifications.tsx"),
  route("admin", "routes/admin.tsx"),
  route("tools", "routes/tools.tsx"),
  route("overlay-control", "routes/overlay-control.tsx"),
  route("channels/callback/:platform", "routes/channels-callback.ts"),
  route("privacy", "routes/privacy.tsx"),
  route("terms", "routes/terms.tsx"),
  route("ai", "routes/ai.tsx"),
  route("commands", "routes/commands.tsx"),
  route("api/auth/*", "routes/auth.ts"),
  route("api/*", "routes/api.ts"),
  // Prevent ":handle/overlay" from matching /api/overlay.
  route("api/overlay", "routes/api.ts", { id: "api-overlay" }),
  route(":handle/overlay", "routes/overlay.tsx"),
  // The private OBS dock: the live controls of one page, opened with the dock key.
  route(":handle/dock", "routes/dock.tsx"),
  route(":handle", "routes/streamer.tsx"),
] satisfies RouteConfig;
