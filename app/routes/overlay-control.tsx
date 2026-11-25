import { redirect, type LoaderFunctionArgs } from "react-router";
import { paths, toolsView } from "../lib/shell";

/**
 * The old address of Overlay control. It moved into Streamer tools: the studio and the OBS link are the Overlay
 * section, and the channel cards are the Channels section. An old channel callback link opens the Channels section.
 */
export function loader({ request }: LoaderFunctionArgs): Response {
  const search = new URL(request.url).searchParams;
  if (!search.has("view")) search.set("view", search.has("channel") ? "channels" : "overlay");
  search.set("view", toolsView(search.get("view")));
  return redirect(`${paths.tools}?${search.toString()}`, 301);
}
