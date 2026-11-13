import { useSyncExternalStore } from "react";
import type { DisplayPrefs } from "../types";
import { changedPrefs, subscribePrefs, withDefaults } from "./prefs";
import { useShell } from "./shell";

// Current page changes override saved preferences; fill missing values with defaults.
export function usePrefs(): Required<DisplayPrefs> {
  const shell = useShell();
  const changed: DisplayPrefs | null = useSyncExternalStore(subscribePrefs, changedPrefs, () => null);
  return withDefaults(changed ?? shell.prefs);
}
