import { test, expect, shimSource } from "../src/index.js";

test.describe("shim modes", () => {
  test("shimSource({ force: true }) installs over an existing modelContext", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: "http://localhost:4173" });
    try {
      const fakeNative = () => {
        Object.defineProperty(document, "modelContext", { value: { native: true, getTools: async () => [] }, configurable: true });
      };
      const probe = async (source: string) => {
        const page = await context.newPage();
        await page.addInitScript(fakeNative);
        await page.addInitScript(source);
        await page.goto("/");
        const result = await page.evaluate(() => {
          const mc = document.modelContext as unknown as Record<string, unknown>;
          return { shim: mc.__webmcpShim === true, native: mc.native === true };
        });
        await page.close();
        return result;
      };
      expect(await probe(shimSource())).toEqual({ shim: false, native: true });
      expect(await probe(shimSource({ force: true }))).toEqual({ shim: true, native: false });
    } finally {
      await context.close();
    }
  });

  test.describe("never", () => {
    test.use({ webmcpOptions: { shim: "never" } });
    test("leaves the page without an API on plain Chromium", async ({ page, webmcp }) => {
      await page.goto("/");
      const snapshot = await webmcp.snapshot();
      test.skip(snapshot.frames[0].api === "native", "this browser has native WebMCP");
      expect(snapshot.frames[0].api).toBe("none");
      // Declarative forms are still discovered from the DOM.
      expect(snapshot.tools.map((t) => t.name)).toEqual(["subscribe_newsletter"]);
    });
  });
});
