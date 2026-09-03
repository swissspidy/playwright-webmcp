import { test, expect } from "../src/index.js";

test.describe("lint", () => {
  test("well formed page passes at warning level", async ({ page, webmcp }) => {
    await page.goto("/");
    await expect(webmcp).toPassLint({ failOn: "warning" });
  });

  test("badly exposed tools produce the expected findings", async ({ page, webmcp }) => {
    await page.goto("/bad.html");
    const result = await webmcp.lint();
    const ids = new Set(result.findings.map((f) => f.ruleId));
    for (const id of [
      "tool-name-valid",
      "description-length",
      "param-description-missing",
      "schema-shape",
      "schema-no-null-literals",
      "similar-descriptions",
      "sensitive-params",
      "declarative-description",
      "declarative-field-description",
      "declarative-autosubmit-sensitive",
    ]) {
      expect(ids, `expected rule ${id} to fire`).toContain(id);
    }
    expect(result.counts.error).toBeGreaterThan(0);
    await expect(webmcp).not.toPassLint();
  });

  test("rules can be disabled and reconfigured", async ({ page, webmcp }) => {
    await page.goto("/bad.html");
    const result = await webmcp.lint({
      rules: {
        "tool-name-valid": false,
        "similar-descriptions": { threshold: 1.01 },
        "sensitive-params": "error",
      },
    });
    const ids = result.findings.map((f) => f.ruleId);
    expect(ids).not.toContain("tool-name-valid");
    expect(ids).not.toContain("similar-descriptions");
    expect(result.findings.find((f) => f.ruleId === "sensitive-params")?.severity).toBe("error");
  });
});
