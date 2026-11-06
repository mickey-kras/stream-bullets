import type { AppEnv } from "../env";
import { isAllowedSupportLink, SUPPORT_PROVIDERS } from "../lib/support";
import type { SupportLink, SupportLinkKind, SupportSettings } from "../types";
import { assertStreamerWritable } from "./access.server";
import { consumeMutationQuota } from "./data.server";
import { HttpError } from "./http.server";
import { supportSettingsSchema, type SupportLinkInput } from "./validation";

interface LinkRow {
  id: string;
  kind: SupportLinkKind;
  label: string | null;
  url: string;
}

export async function getSupport(env: AppEnv, streamerId: string): Promise<SupportSettings> {
  const [links, settings] = await Promise.all([
    env.DB.prepare("SELECT id,kind,label,url FROM streamer_links WHERE streamer_id=? ORDER BY position")
      .bind(streamerId)
      .all<LinkRow>(),
    env.DB.prepare("SELECT support_visible, support_card FROM streamers WHERE id=?")
      .bind(streamerId)
      .first<{ support_visible: number; support_card: number }>(),
  ]);
  return {
    links: links.results.map(
      (row: LinkRow): SupportLink => ({ id: row.id, kind: row.kind, label: row.label, url: row.url }),
    ),
    visible: settings?.support_visible === 1,
    card: settings?.support_card === 1,
  };
}

/** Checks one link against its provider's domain allow-list. Returns the error to show, or null. */
export function supportLinkError(link: SupportLinkInput, index: number): string | null {
  const provider = SUPPORT_PROVIDERS[link.kind];
  if (!isAllowedSupportLink(link.kind, link.url))
    return link.kind === "other"
      ? `Link ${index + 1}: use an https link to a page on the site.`
      : `Link ${index + 1}: use an https link on ${provider.label}'s own domain.`;
  if (link.kind === "other" && !link.label) return `Link ${index + 1}: add a button label.`;
  return null;
}

/** `PUT /api/support-links`: replaces the owner's links (at most 4) and where they show, in one batch. */
export async function saveSupport(env: AppEnv, viewerId: string, value: unknown): Promise<SupportSettings> {
  const result = supportSettingsSchema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? "Invalid support links.");
  const input = result.data;
  for (const [index, link] of input.links.entries()) {
    const error = supportLinkError(link, index);
    if (error) throw new HttpError(400, error);
  }
  const page = await env.DB.prepare("SELECT id FROM streamers WHERE owner_id=?").bind(viewerId).first<{ id: string }>();
  if (!page) throw new HttpError(403, "Only streamers can add support links.");
  await assertStreamerWritable(env, page.id, viewerId);
  await consumeMutationQuota(env, viewerId, true);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM streamer_links WHERE streamer_id=?").bind(page.id),
    ...input.links.map((link: SupportLinkInput, position: number) =>
      env.DB.prepare("INSERT INTO streamer_links (id,streamer_id,position,kind,label,url) VALUES (?,?,?,?,?,?)").bind(
        crypto.randomUUID(),
        page.id,
        position,
        link.kind,
        link.kind === "other" ? link.label : null,
        link.url.trim(),
      ),
    ),
    env.DB.prepare("UPDATE streamers SET support_visible=?, support_card=? WHERE id=?").bind(
      input.visible ? 1 : 0,
      input.card ? 1 : 0,
      page.id,
    ),
  ]);
  return getSupport(env, page.id);
}
