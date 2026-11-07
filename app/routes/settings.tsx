import { redirect } from "react-router";
import { paths } from "../lib/shell";

/** Settings are account dialogs now (item 17, R3): the old page opens Your profile over the Streamers list. */
export function loader(): Response {
  return redirect(paths.profile, 302);
}
