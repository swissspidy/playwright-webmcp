import { test, expect } from "../src/index.js";

test.describe("cross-origin exposure", () => {
  test("snapshot sees every frame, reachability respects allow and exposedTo", async ({ page, webmcp }) => {
    await page.goto("/embed.html");
    const snapshot = await webmcp.snapshot();
    expect(snapshot.frames).toHaveLength(3);
    expect(snapshot.frames[1].crossOriginFromTop).toBe(true);
    expect(snapshot.frames[1].allow).toBe("tools");
    expect(snapshot.frames[2].allow).toBeNull();
    expect(snapshot.tools.find((t) => t.name === "partner_quote" && t.frame === 1)?.exposedTo).toEqual(["http://localhost:4173"]);

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
    const quote = await page.evaluate(async () => {
      const mc = (document.modelContext ?? navigator.modelContext)!;
      const tools = await mc.getTools({ fromOrigins: ["http://127.0.0.1:4173"] });
      const remote = tools.find((t) => t.name === "partner_quote")!;
      return mc.executeTool(remote, { country: "CH", weightKg: 2 });
    });
    expect(quote).toEqual({ country: "CH", weightKg: 2, price: 15, currency: "CHF" });
    const denied = await page.evaluate(async () => {
      const mc = (document.modelContext ?? navigator.modelContext)!;
      const tools = await mc.getTools({ fromOrigins: ["http://127.0.0.1:4173"] });
      return tools.map((t) => t.name);
    });
    expect(denied).not.toContain("partner_private");
    // The fixture can still call the private tool directly, because it evaluates inside the frame.
    expect(await webmcp.call("partner_private")).toEqual({ secret: true });
  });

  test("lint flags a cross-origin frame that registers tools without allow=\"tools\"", async ({ page, webmcp }) => {
    await page.goto("/embed.html");
    const result = await webmcp.lint({ rules: { "duplicate-tool-name": false } });
    const f = result.findings.find((x) => x.ruleId === "iframe-allow-tools");
    expect(f?.frame).toBe(2);
    expect(result.findings.find((x) => x.ruleId === "exposed-to-secure-origins")).toBeUndefined();
    await expect(async () => {
      await page.evaluate(async () => {
        const mc = (document.modelContext ?? navigator.modelContext)!;
        await mc.registerTool({ name: "leaky", description: "x", execute: async () => ({}) }, { exposedTo: ["http://evil.example"] });
      });
    }).rejects.toThrow(/secure/);
  });
});
