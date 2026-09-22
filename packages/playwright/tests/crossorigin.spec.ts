import { test, expect } from "../src/index.js";
import { executeToolInPage } from "./helpers.js";

test.describe("cross-origin exposure", () => {
  test("snapshot sees every frame, reachability respects allow and exposedTo", async ({ page, webmcp }) => {
    await page.goto("/embed.html");
    const snapshot = await webmcp.snapshot();
    expect(snapshot.frames).toHaveLength(3);
    expect(snapshot.frames[1].crossOriginFromTop).toBe(true);
    // The second partner frame is embedded without allow="tools": the "tools" permissions policy
    // keeps it from registering anything, so the page's surface is the first frame's tools only.
    expect(snapshot.tools.filter((t) => t.frame === 2)).toEqual([]);

    const reachable = await webmcp.reachableTools();
    expect(reachable.map((t) => t.name).sort()).toEqual(["host_tool", "partner_quote"]);
    expect(reachable.find((t) => t.name === "partner_quote")).toMatchObject({ remote: true, origin: "http://127.0.0.1:4173" });
    await expect(webmcp).toReachTool("partner_quote");
    await expect(webmcp).not.toReachTool("partner_private");
    // From inside the partner frame only its own tools are visible.
    expect((await webmcp.reachableTools({ from: 1 })).map((t) => t.name).sort()).toEqual(["partner_private", "partner_quote"]);
  });

  test("remote tools execute through the bridge with the embedder's origin checked", async ({ page, webmcp }) => {
    await page.goto("/embed.html");
    const quote = await executeToolInPage(page, "partner_quote", { country: "CH", weightKg: 2 }, { fromOrigins: ["http://127.0.0.1:4173"] });
    // executeTool() resolves with the JSON-serialized result, as the specification says.
    expect(typeof quote).toBe("string");
    expect(JSON.parse(quote as string)).toEqual({ country: "CH", weightKg: 2, price: 15, currency: "CHF" });
    const denied = await page.evaluate(async () => {
      const mc = document.modelContext!;
      const tools = await mc.getTools({ fromOrigins: ["http://127.0.0.1:4173"] });
      return tools.map((t) => t.name);
    });
    expect(denied).not.toContain("partner_private");
    // The fixture can still call the private tool directly, because it evaluates inside the frame.
    expect(await webmcp.call("partner_private")).toEqual({ secret: true });
  });

  test("the API rejects insecure exposedTo origins and the wildcard, as the lint rule says it will", async ({ page, webmcp }) => {
    await page.goto("/embed.html");
    const result = await webmcp.lint();
    expect(result.findings.find((x) => x.ruleId === "exposed-to-secure-origins")).toBeUndefined();
    for (const exposedTo of [["http://evil.example"], ["*"]]) {
      await expect(async () => {
        await page.evaluate(async (origins) => {
          const mc = document.modelContext!;
          await mc.registerTool(
            { name: "leaky", description: "Exposed to somewhere the API does not allow.", execute: async () => ({}) },
            { exposedTo: origins },
          );
        }, exposedTo);
      }).rejects.toThrow(/SecurityError|secure|trustworthy|origin/i);
    }
    await expect(webmcp).not.toHaveTool("leaky");
  });

  test("mocking and restoring a tool keeps its exposedTo", async ({ page, webmcp }) => {
    await page.goto("/embed.html");
    await webmcp.mock("partner_quote", { result: { price: 1, currency: "CHF", mocked: true } });
    await expect(webmcp).toReachTool("partner_quote");
    const viaEmbedder = await executeToolInPage(page, "partner_quote", { country: "CH" }, { fromOrigins: ["http://127.0.0.1:4173"] });
    expect(JSON.parse(viaEmbedder as string)).toEqual({ price: 1, currency: "CHF", mocked: true });
    expect(await webmcp.unmock("partner_quote")).toBe(true);
    await expect(webmcp).toReachTool("partner_quote");
    expect(await webmcp.call("partner_quote", { country: "CH", weightKg: 2 })).toMatchObject({ price: 15 });
  });
});
