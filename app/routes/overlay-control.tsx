import { redirect, type LoaderFunctionArgs } from "react-router";
import { paths, toolsViews, type ToolsView } from "../lib/shell";

/**
 * The old address of Overlay control. It moved into Streamer tools: the studio and the OBS link are the Overlay
 * section, and the channel cards are the Channels section. An old channel callback link opens the Channels section.
 * An address without a known section opens the Overlay section, not the Live section that Streamer tools starts with.
 */
export function loader({ request }: LoaderFunctionArgs): Response {
  const search = new URL(request.url).searchParams;
  const asked: string | null = search.get("view");
  const known: ToolsView | undefined = toolsViews.find((view: ToolsView): boolean => view === asked);
  search.set("view", known ?? (asked === null && search.has("channel") ? "channels" : "overlay"));
  return redirect(`${paths.tools}?${search.toString()}`, 301);
}
