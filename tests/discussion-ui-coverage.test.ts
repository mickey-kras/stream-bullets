import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { expect, it } from "vitest";
import { DeleteButton, Discussion } from "../app/components/discussion";
import { MentionInput } from "../app/components/mention-input";
import { Notifications } from "../app/components/notifications";
import type { NotificationSnapshot, StreamerStatus, Viewer } from "../app/types";

async function render(content: ReactNode): Promise<string> {
  const handler = createStaticHandler([{ path: "/", Component: (): ReactNode => content }]);
  const context = await handler.query(new Request("https://stream.example.test/"));
  if (context instanceof Response) throw new Error("Expected a discussion render.");
  return renderToStaticMarkup(
    createElement(StaticRouterProvider, {
      router: createStaticRouter(handler.dataRoutes, context),
      context,
      hydrate: false,
    }),
  );
}

it("keeps delete controls enabled by default and exposes the full accessible label for a short caption", () => {
  const onDelete = async (): Promise<void> => {};
  const enabled: string = renderToStaticMarkup(createElement(DeleteButton, { label: "Delete comment", onDelete }));
  expect(enabled).toContain("Delete comment</button>");
  expect(enabled).not.toContain("disabled");
  const disabled: string = renderToStaticMarkup(
    createElement(DeleteButton, {
      label: "Delete comment",
      text: "Delete",
      disabled: true,
      onDelete,
    }),
  );
  expect(disabled).toContain('disabled="" aria-label="Delete comment"');
  expect(disabled).toContain("Delete</button>");
});

it.each<StreamerStatus>(["frozen", "suspended"])("renders a disabled composer on a %s page", async (status) => {
  const viewer: Viewer = {
    id: "viewer",
    name: "Viewer",
    avatar: null,
    avatarPreset: null,
    locale: null,
    displayPrefs: null,
    keepOriginal: [],
  };
  const markup: string = await render(
    createElement(Discussion, {
      entryId: "entry",
      handle: "host",
      viewer,
      ownerId: "owner",
      status,
      refreshKey: 0,
      onChanged: (): void => {},
    }),
  );
  expect(markup).toMatch(/<textarea[^>]*disabled=""[^>]*aria-label="Write a comment"/u);
  expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/u);
  expect(markup).toContain(
    status === "frozen"
      ? "Comments are paused while this page is frozen."
      : "Comments are closed while this page is suspended.",
  );
});

it("renders the empty inbox and saved opt-out preferences together", async () => {
  const initial: NotificationSnapshot = {
    notifications: [],
    nextCursor: null,
    unreadCount: 0,
    preferences: { replies: false, mentions: false },
  };
  const markup: string = await render(createElement(Notifications, { initial }));
  expect(markup).toContain("No notifications yet.");
  expect(markup).toContain("Unread notifications: 0");
  expect(markup).not.toContain('checked=""');
  expect(markup).not.toContain("Load more notifications");
});

it("renders a disabled mention editor with the supplied draft and input boundary", () => {
  const markup: string = renderToStaticMarkup(
    createElement(MentionInput, {
      entryId: "entry",
      value: "Draft <text>",
      mentions: [],
      onChange: (): void => {},
      onMentionsChange: (): void => {},
      label: "Edit comment",
      placeholder: "Comment",
      disabled: true,
    }),
  );
  expect(markup).toContain('disabled="" maxLength="2000"');
  expect(markup).toContain('aria-label="Edit comment"');
  expect(markup).toContain("Draft &lt;text&gt;");
  expect(markup).not.toContain('class="mention-options"');
});
