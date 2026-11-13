import { redirect } from "react-router";
import { paths } from "../lib/shell";

// Legacy Settings URL opens the profile dialog over the directory.
export function loader(): Response {
  return redirect(paths.profile, 302);
}
