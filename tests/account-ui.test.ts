import { describe, expect, it } from "vitest";
import { clampZoom, cropGeometry, initialCrop, panBy, settle, zoomTo } from "../app/components/account/crop";
import { nextHandleChange } from "../app/components/account/edit-page-dialog";
import { confirmsDeletion, deletionItems } from "../app/components/account/data-dialog";
import { dialogHref } from "../app/components/account/dialog-route";
import { AVATAR_ORDER, personPicture, streamerPicture } from "../app/lib/avatars";
import { directoryHref, readIntent, streamerTarget } from "../app/lib/directory";

describe("crop maths", (): void => {
  const landscape = { width: 1200, height: 800 };

  it("covers the stage at zoom 1 and centres the source square", (): void => {
    const g = cropGeometry(300, landscape, initialCrop);
    expect(g.height).toBe(300);
    expect(g.width).toBe(450);
    expect(g.side).toBe(800);
    expect(g.sx).toBe(200);
    expect(g.sy).toBe(0);
  });

  it("clamps the pan so no gap shows, and zoom to 1–4", (): void => {
    const far = cropGeometry(300, landscape, panBy(initialCrop, 1000, -1000));
    expect(far.x).toBe(75);
    expect(far.y).toBe(0);
    expect(far.sx).toBe(0);
    expect(clampZoom(0.2)).toBe(1);
    expect(clampZoom(9)).toBe(4);
    expect(clampZoom(Number.NaN)).toBe(1);
    const zoomed = cropGeometry(300, landscape, { zoom: 4, x: 0, y: 0 });
    expect(zoomed.side).toBe(200);
    expect(zoomed.sx).toBe(500);
    expect(zoomed.sy).toBe(300);
  });

  it("zooms about the centre and settles the pan where the picture really is", (): void => {
    expect(zoomTo({ zoom: 2, x: 10, y: -20 }, 4)).toEqual({ zoom: 4, x: 20, y: -40 });
    expect(zoomTo({ zoom: 2, x: 10, y: -20 }, 10)).toEqual({ zoom: 4, x: 20, y: -40 });
    const settled = settle(300, landscape, panBy(initialCrop, 500, 0));
    expect(settled).toEqual({ zoom: 1, x: 75, y: 0 });
    // Moving back starts from the clamped edge, not from the overshoot.
    expect(cropGeometry(300, landscape, panBy(settled, -75, 0)).x).toBe(0);
  });
});

describe("pictures", (): void => {
  it("orders the presets with the default Space explorer first and no initials option", (): void => {
    expect(AVATAR_ORDER).toEqual([14, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 15]);
    expect(new Set(AVATAR_ORDER).size).toBe(18);
    expect(personPicture(null, null)).toEqual({ kind: "preset", preset: 14 });
    expect(personPicture(null, 3)).toEqual({ kind: "preset", preset: 3 });
    expect(personPicture("/images/avatar/u", 3)).toEqual({ kind: "photo", url: "/images/avatar/u" });
  });

  it("falls back from the page logo to the owner's picture, then the default", (): void => {
    expect(streamerPicture({ logo: "/images/logo/u", avatar: "/images/avatar/u", ownerAvatarPreset: 2 })).toEqual({
      kind: "photo",
      url: "/images/logo/u",
    });
    expect(streamerPicture({ logo: null, avatar: "/images/avatar/u", ownerAvatarPreset: 2 })).toEqual({
      kind: "photo",
      url: "/images/avatar/u",
    });
    expect(streamerPicture({ logo: null, avatar: null, ownerAvatarPreset: 2 })).toEqual({ kind: "preset", preset: 2 });
    expect(streamerPicture({})).toEqual({ kind: "preset", preset: 14 });
  });
});

describe("account dialogs", (): void => {
  it("opens dialogs on the current URL and keeps its other parameters", (): void => {
    const here = { pathname: "/@zed", search: "?view=polls", hash: "#x" };
    expect(dialogHref(here, "profile")).toBe("/@zed?view=polls&dialog=profile#x");
    expect(dialogHref({ ...here, search: "?view=polls&dialog=data" }, null)).toBe("/@zed?view=polls#x");
  });

  it("allows one handle change every 30 days", (): void => {
    const day = 24 * 60 * 60 * 1000;
    expect(nextHandleChange(null, 0)).toBeNull();
    expect(nextHandleChange(0, 29 * day)).toBe(30 * day);
    expect(nextHandleChange(0, 30 * day)).toBeNull();
  });

  it("confirms deletion in any case and words the list for the account", (): void => {
    expect(confirmsDeletion(" delete ")).toBe(true);
    expect(confirmsDeletion("DELET")).toBe(false);
    const viewer = deletionItems({ provider: "tiktok", owner: false });
    expect(viewer).toContain("Your TikTok sign-in link and every signed-in session");
    expect(viewer.join(" ")).not.toContain("streamer page");
    expect(deletionItems({ provider: null, owner: true })).toContain("Your streamer page and everything posted on it");
  });
});

describe("landing sign intents", (): void => {
  it("sends each sign to the directory and each card to the matching action", (): void => {
    expect(readIntent("vote")).toBe("vote");
    expect(readIntent("other")).toBeNull();
    expect(directoryHref("suggest")).toBe("/streamers?then=suggest");
    expect(directoryHref(null)).toBe("/streamers");
    expect(streamerTarget("zed", "suggest")).toBe("/@zed?view=topics&intent=suggest");
    expect(streamerTarget("zed", "vote")).toBe("/@zed?view=polls");
    expect(streamerTarget("streambullets", "vote", true)).toBe("/@streambullets?view=topics");
    expect(streamerTarget("zed", "discuss")).toBe("/@zed?view=topics&sort=top&intent=discuss");
    expect(streamerTarget("zed", null)).toBe("/@zed");
  });
});
