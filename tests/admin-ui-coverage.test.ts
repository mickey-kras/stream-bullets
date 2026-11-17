import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { KeyConfirm } from "../app/components/admin/key-confirm";
import { actionIcon, actionLabel, pageActions } from "../app/components/admin/moderate-sheet";
import { ReportGroups } from "../app/components/admin/report-groups";
import { KeySetup, SecurityKeys } from "../app/components/admin/security-keys";
import { StreamerPages } from "../app/components/admin/streamer-pages";
import type { AdminPage, ReportGroup, SecurityKey, StepUpStatus } from "../app/types";

const status: StepUpStatus = {
  mode: "report",
  keys: 0,
  requiredKeys: 2,
  verifiedAt: null,
  freshUntil: null,
  canRegister: true,
  registerBlock: "none",
  need: "none",
  serverNow: 1_800_000_000_000,
};
const key: SecurityKey = {
  id: "desk",
  name: "Desk key",
  createdAt: null,
  lastUsedAt: null,
  backedUp: false,
  transports: ["usb"],
};
const page: AdminPage = {
  id: "page",
  handle: "host",
  name: "Host",
  logo: null,
  avatar: null,
  ownerAvatarPreset: null,
  isOfficial: false,
  status: "active",
  statusReason: null,
  statusChangedAt: null,
  owner: { id: null, name: "", avatar: null, avatarPreset: null, email: "" },
  topics: 0,
  polls: 0,
  history: [],
};

async function markup(element: ReactElement): Promise<string> {
  const handler = createStaticHandler([{ path: "/admin", Component: () => element, loader: () => null }]);
  const context = await handler.query(new Request("https://stream.example.test/admin"));
  if (context instanceof Response) throw new Error("Expected admin route data.");
  return renderToStaticMarkup(
    createElement(StaticRouterProvider, {
      router: createStaticRouter(handler.dataRoutes, context),
      context,
    }),
  );
}

describe("security-key setup and recovery", (): void => {
  it("distinguishes first registration, an expired sign-in and backup confirmation", async (): Promise<void> => {
    const first = await markup(createElement(KeySetup, { status, keys: [], standalone: true }));
    expect(first).toContain("Set up your security keys</h1>");
    expect(first).toContain('value="YubiKey – desk"');
    expect(first).toContain('maxLength="40"');
    const expired = await markup(
      createElement(KeySetup, {
        status: { ...status, canRegister: false, registerBlock: "sign_in_again" },
        keys: [],
      }),
    );
    expect(expired).toContain("add it within 5 minutes");
    expect(expired).not.toContain('name="name"');
    const backup = await markup(
      createElement(KeySetup, {
        status: { ...status, keys: 1, canRegister: false, registerBlock: "step_up" },
        keys: [key],
      }),
    );
    expect(backup).toContain("Confirm with a key you already registered");
    expect(backup).toContain("Use security key");
    expect(backup).not.toContain('name="name"');
    const registerBackup = await markup(createElement(KeySetup, { status: { ...status, keys: 1 }, keys: [key] }));
    expect(registerBackup).toContain('value="YubiKey – safe"');
    const done = await markup(
      createElement(KeySetup, { status: { ...status, keys: 2 }, keys: [key, { ...key, id: "safe", name: "Safe" }] }),
    );
    expect(done).toContain("Both keys are set up");
    expect(done).toContain('href="/admin"');
    expect(done).not.toContain('name="name"');
  });

  it("displays missing versus recorded key timestamps and routes an unconfigured account to setup", async (): Promise<void> => {
    const managed = await markup(
      createElement(SecurityKeys, {
        status: { ...status, keys: 2 },
        keys: [key, { ...key, id: "safe", name: "Safe", createdAt: status.serverNow, lastUsedAt: status.serverNow }],
      }),
    );
    expect(managed).toContain('aria-label="Remove Safe"');
    expect(managed).toContain("<time");
    expect(managed).toContain("Never");
    expect(managed).not.toContain('disabled="" aria-label="Remove Safe"');
    const setup = await markup(createElement(SecurityKeys, { status, keys: [] }));
    expect(setup).toContain("Add your first key");
    expect(setup).not.toContain('aria-label="Rename');
  });

  it("renders a page heading, an embedded confirmation and a custom removal label", async (): Promise<void> => {
    const gate = await markup(createElement(KeyConfirm, { pageHeading: true, onConfirmed: () => undefined }));
    expect(gate).toContain('<h1 id="gate-title">');
    expect(gate).toContain("Lost your keys?");
    const embedded = await markup(
      createElement(KeyConfirm, {
        inDialog: true,
        label: "Confirm with another key",
        onConfirmed: () => undefined,
      }),
    );
    expect(embedded).toContain("Confirm with another key");
    expect(embedded).not.toContain('id="gate-title"');
  });
});

describe("moderation list contracts", (): void => {
  it("offers only the valid actions for each page status", (): void => {
    expect(pageActions("active")).toEqual(["freeze", "suspend"]);
    expect(pageActions("frozen")).toEqual(["unfreeze", "suspend"]);
    expect(pageActions("suspended")).toEqual(["unsuspend"]);
    expect(
      ["freeze", "unfreeze", "suspend", "unsuspend"].map((action) =>
        actionIcon(action as "freeze" | "unfreeze" | "suspend" | "unsuspend"),
      ),
    ).toEqual(["lock", "reset", "eye-off", "eye"]);
    expect(actionLabel("unsuspend")).toBe("Unsuspend");
  });

  it("keeps search in filters, shows audit history and falls back for deleted owners", async (): Promise<void> => {
    const html = await markup(
      createElement(StreamerPages, {
        filter: "suspended",
        query: "Host",
        list: {
          pages: [
            {
              ...page,
              status: "suspended",
              statusReason: "spam",
              isOfficial: true,
              history: ["official", "unofficial", "external_audit", "unsuspend"].map((action, index) => ({
                id: String(index),
                action,
                reason: index === 0 ? "" : "spam",
                note: index === 0 ? "" : "Reviewed",
                notifyOwner: false,
                actor: index === 0 ? null : "Moderator",
                createdAt: status.serverNow,
              })),
            },
            {
              ...page,
              id: "second",
              handle: "second",
              status: "suspended",
              owner: { ...page.owner, name: "Owner", email: "owner@example.test" },
            },
          ],
          nextCursor: "next",
        },
      }),
    );
    expect(html).toContain("a deleted account");
    expect(html).toContain('href="mailto:owner@example.test"');
    expect(html).toContain("external_audit");
    expect(html).toContain("Marked official");
    expect(html).toContain("Official mark removed");
    expect(html).toContain('aria-label="Unsuspend @host"');
    expect(html).toContain("Load more pages");
    expect(html).toContain("status=frozen&amp;query=Host");
    expect(html).toContain('name="status" value="suspended"');
    expect(html).toContain("No moderation actions.");
    const empty = await markup(
      createElement(StreamerPages, { filter: "all", query: "", list: { pages: [], nextCursor: null } }),
    );
    expect(empty).toContain("Nothing to show yet.");
    expect(empty).not.toContain('name="status"');
  });

  it("retains reports for deleted pages and distinguishes empty open and resolved filters", async (): Promise<void> => {
    const group: ReportGroup = {
      streamer: null,
      streamerId: "deleted",
      reports: 3,
      items: 2,
      open: 1,
      last30Days: 3,
      newest: status.serverNow,
      reasons: [{ reason: "privacy", count: 3 }],
    };
    const html = await markup(
      createElement(ReportGroups, {
        filter: "resolved",
        query: "host",
        list: { groups: [group], next: "next" },
      }),
    );
    expect(html.match(/class="info-card application-card report-group"/gu)).toHaveLength(1);
    expect(html).toContain("Deleted page");
    expect(html).toContain("Privacy ×3");
    expect(html).not.toContain("Dismiss all open</button>");
    expect(html).toContain('name="status" value="resolved"');
    expect(html).toContain("status=all&amp;query=host");
    for (const filter of ["open", "resolved"] as const) {
      const empty = await markup(createElement(ReportGroups, { filter, query: "", list: { groups: [], next: null } }));
      expect(empty).toContain(filter === "open" ? "Nothing needs review" : "Resolved reports show here");
    }
  });
});
