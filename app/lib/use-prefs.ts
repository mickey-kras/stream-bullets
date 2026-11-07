import { useSyncExternalStore } from "react";
import type { DisplayPrefs } from "../types";
import { changedPrefs, subscribePrefs, withDefaults } from "./prefs";
import { useShell } from "./shell";

/** The display preferences in effect: a change made in this page view, else the saved ones, with defaults. */
export function usePrefs(): Required<DisplayPrefs> {
  const shell = useShell();
  const changed: DisplayPrefs | null = useSyncExternalStore(subscribePrefs, changedPrefs, () => null);
  return withDefaults(changed ?? shell.prefs);
}
