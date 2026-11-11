import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { expect, it } from "vitest";
import Streamers from "../app/routes/streamers";

it("gives signed-out visitors a host request link when the directory is empty", async (): Promise<void> => {
  const handler = createStaticHandler([{
    path: "/streamers",
    Component: Streamers,
    loader: () => ({ streamers: [], total: 0, nextCursor: null, featured: null, query: "", intent: null }),
  }]);
  const result = await handler.query(new Request("https://stream.example.test/streamers"));
  if (result instanceof Response) throw new Error("Expected directory data.");
  const markup: string = renderToStaticMarkup(createElement(StaticRouterProvider, {
    router: createStaticRouter(handler.dataRoutes, result), context: result,
  }));
  expect(markup).toContain("No streamer pages yet.");
  expect(markup).toContain('href="/streamers?dialog=host"');
  expect(markup).toContain("Viewers can ask their streamer to join.");
  expect(markup).not.toContain('id="featured-title"');
});
