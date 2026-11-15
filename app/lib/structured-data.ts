import type { Entry, StreamEvent, Streamer } from "../types";

// Route metadata uses script:ld+json. Include public names, links, schedule times and topic text only.
export type JsonLd = Record<string, unknown>;

const CONTEXT = "https://schema.org";
const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  twitch: "Twitch",
  youtube: "YouTube",
  kick: "Kick",
  tiktok: "TikTok",
  other: "Online",
};

export function siteJsonLd(origin: string): JsonLd {
  return {
    "@context": CONTEXT,
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${origin}/#website`,
        name: "StreamBullets",
        url: `${origin}/`,
        description: "Live-stream audiences suggest topics, vote in polls and discuss the stream.",
        publisher: { "@id": `${origin}/#organization` },
      },
      {
        "@type": "Organization",
        "@id": `${origin}/#organization`,
        name: "StreamBullets",
        url: `${origin}/`,
        logo: `${origin}/brand/stream-bullets-icon.svg`,
      },
    ],
  };
}

export function personJsonLd(streamer: Pick<Streamer, "name" | "handle" | "about">, origin: string): JsonLd {
  return {
    "@context": CONTEXT,
    "@type": "Person",
    name: streamer.name,
    alternateName: `@${streamer.handle}`,
    url: `${origin}/@${streamer.handle}`,
    ...(streamer.about ? { description: streamer.about.slice(0, 300) } : {}),
  };
}

// Exclude ended/cancelled streams; return at most limit.
export function eventsJsonLd(
  events: readonly StreamEvent[],
  streamer: Pick<Streamer, "name" | "handle">,
  origin: string,
  now: number,
  limit = 5,
): JsonLd[] {
  return events
    .filter(
      (event: StreamEvent) =>
        (event.status === "scheduled" || event.status === "live") && event.startsAt >= now - 86_400_000,
    )
    .slice(0, limit)
    .map(
      (event: StreamEvent): JsonLd => ({
        "@context": CONTEXT,
        "@type": "Event",
        name: event.title,
        startDate: new Date(event.startsAt).toISOString(),
        endDate: new Date(event.startsAt + event.durationMin * 60_000).toISOString(),
        eventStatus: "https://schema.org/EventScheduled",
        eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
        location: { "@type": "VirtualLocation", name: PLATFORM_NAMES[event.platform] ?? "Online", url: event.url },
        organizer: { "@type": "Person", name: streamer.name, url: `${origin}/@${streamer.handle}` },
        url: `${origin}/@${streamer.handle}?view=schedule&event=${event.id}`,
      }),
    );
}

// Opened entry selected by ?entry=.
export function postingJsonLd(
  entry: Pick<Entry, "id" | "kind" | "title" | "body" | "author" | "createdAt" | "comments" | "likes">,
  streamer: Pick<Streamer, "handle">,
  origin: string,
): JsonLd {
  const view: string = entry.kind === "topic" ? "topics" : "polls";
  return {
    "@context": CONTEXT,
    "@type": "DiscussionForumPosting",
    headline: entry.title,
    ...(entry.body ? { text: entry.body.slice(0, 500) } : {}),
    author: { "@type": "Person", name: entry.author },
    datePublished: new Date(entry.createdAt).toISOString(),
    url: `${origin}/@${streamer.handle}?view=${view}&entry=${entry.id}`,
    interactionStatistic: [
      {
        "@type": "InteractionCounter",
        interactionType: "https://schema.org/CommentAction",
        userInteractionCount: entry.comments,
      },
      {
        "@type": "InteractionCounter",
        interactionType: "https://schema.org/LikeAction",
        userInteractionCount: entry.likes,
      },
    ],
  };
}
