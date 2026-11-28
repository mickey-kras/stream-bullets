import { createContext } from "react";
import type { AlertControl, AlertsReply } from "../../lib/alert-control";
import type { OverlayState } from "../../types";
import { postJson, requestJson } from "../api";
import type { ControlAction } from "./use-overlay-state";

/**
 * How the live controls reach the server. Streamer tools uses the session of the owner. The OBS dock has no
 * session: each of its requests carries the dock key, and the key allows the live controls only.
 */
export interface ControlApi {
  /** The dock key, for the requests and the sockets of the dock. Null: the session of the owner. */
  key: string | null;
  /** Saves an overlay action and gives the new state. */
  overlay: (action: ControlAction) => Promise<{ overlay: OverlayState }>;
  /** Closes the voting of a poll of the page `handle`. */
  closePoll: (handle: string, id: string) => Promise<void>;
  /** Sends one alert control: test, mute, skip, replay, status, or a goal reset. */
  alerts(control: AlertControl): Promise<AlertsReply>;
}

export const SESSION_API: ControlApi = {
  key: null,
  overlay: (action: ControlAction) => postJson<{ overlay: OverlayState }>("/api/overlay", action),
  closePoll: async (handle: string, id: string): Promise<void> => {
    await postJson<{ id: string }>(`/api/streamers/${handle}`, { action: "reveal", id });
  },
  /** Sends one alert control: test, mute, skip, replay, status, or a goal reset. */
  alerts: (control: AlertControl): Promise<AlertsReply> => postJson<AlertsReply>("/api/overlay/alerts", control),
};

/** The control API of the OBS dock of the page `handle`. The key goes in a header, never in the address. */
export function dockApi(handle: string, key: string): ControlApi {
  const post = <T>(path: string, body: unknown): Promise<T> =>
    requestJson<T>(`/api/dock/${handle}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SB-Dock-Key": key },
      body: JSON.stringify(body),
    });
  return {
    key,
    overlay: (action: ControlAction) => post<{ overlay: OverlayState }>("overlay", action),
    closePoll: async (_handle: string, id: string): Promise<void> => {
      await post<{ id: string }>("poll", { id });
    },
    /** Sends one alert control: test, mute, skip, replay, status, or a goal reset. */
    alerts: (control: AlertControl): Promise<AlertsReply> => post<AlertsReply>("alerts", control),
  };
}

export const ControlApiContext = createContext<ControlApi>(SESSION_API);
