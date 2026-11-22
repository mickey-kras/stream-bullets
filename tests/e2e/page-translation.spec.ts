import { createHash, randomUUID } from "node:crypto";
import { close, expect, newPage, test } from "./coverage";
import { runSql } from "./fixtures";

// The hash that the server computes for a text of a page.
function hash(kind: string, title: string, body: string, options: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, title, body, options]))
    .digest("hex");
}

function stored(sourceHash: string, title: string, body: string, options: string[]): string {
  const value: string = JSON.stringify({ title, body, options }).replaceAll("'", "''");
  return `INSERT OR REPLACE INTO page_translations(streamer_id,source_hash,locale,value,created_at) SELECT id,'${sourceHash}','en','${value}',1 FROM streamers WHERE handle='pagination_host';`;
}

test("a reader gets the About text, a card and a stream in the site language and can see each original", async ({
  browser,
}) => {
  const eventId: string = randomUUID();
  const cardId: string = randomUUID();
  const startsAt: number = Date.now() + 86_400_000;
  await runSql("page-translation", [
    `DELETE FROM community_cards WHERE streamer_id=(SELECT id FROM streamers WHERE handle='pagination_host');`,
    `INSERT INTO community_cards(id,streamer_id,position,title,body,button_label,button_target) SELECT '${cardId}',id,0,'Regeln','Seid nett.','Mehr lesen','tab:about' FROM streamers WHERE handle='pagination_host';`,
    `INSERT INTO stream_events(id,streamer_id,title,notes,starts_at,duration_min,platform,url,tz,created_at,updated_at) SELECT '${eventId}',id,'Montagsrunde','Wir spielen zusammen.',${startsAt},60,'twitch','https://twitch.tv/pagination_host','UTC',1,1 FROM streamers WHERE handle='pagination_host';`,
    stored(hash("about", "", "A community with older entries.", []), "", "Translated About text.", []),
    stored(hash("card", "Regeln", "Seid nett.", ["Mehr lesen"]), "Rules", "Be kind.", ["Read more"]),
    stored(hash("event", "Montagsrunde", "Wir spielen zusammen.", []), "Monday round", "We play together.", []),
  ]);
  const page = await newPage(browser);
  try {
    await page.goto("/@pagination_host?view=about");
    const about = page.locator(".about-card");
    await expect(about.locator(".description")).toHaveText("Translated About text.");
    await about.getByRole("button", { name: "Show original", exact: true }).click();
    await expect(about.locator(".description")).toHaveText("A community with older entries.");

    await page.goto("/@pagination_host?view=community");
    const card = page.locator(`[data-card="${cardId}"]`);
    await expect(card.getByRole("heading", { name: "Rules" })).toBeVisible();
    await expect(card.getByRole("link", { name: "Read more" })).toBeVisible();
    await card.getByRole("button", { name: "Show original", exact: true }).click();
    await expect(card.getByRole("heading", { name: "Regeln" })).toBeVisible();
    await expect(card).toContainText("Seid nett.");
    await card.getByRole("button", { name: "Show translation", exact: true }).click();
    await expect(card).toContainText("Be kind.");

    await page.goto("/@pagination_host?view=schedule");
    await page.getByRole("button", { name: "Monday round", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("We play together.");
    await dialog.getByRole("button", { name: "Show original", exact: true }).click();
    await expect(dialog).toContainText("Wir spielen zusammen.");
    // The schedule behind the dialog shows the original of this stream too.
    await expect(page.locator("#up-next-title")).toHaveText("Montagsrunde");
  } finally {
    await close(page);
    // Other specs use this page without cards and streams.
    await runSql("page-translation", [
      `DELETE FROM community_cards WHERE id='${cardId}';`,
      `DELETE FROM stream_events WHERE id='${eventId}';`,
      `DELETE FROM page_translations;`,
    ]);
  }
});
