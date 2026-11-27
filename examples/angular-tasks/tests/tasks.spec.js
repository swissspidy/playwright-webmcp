import { test, expect } from "@swissspidy/playwright-webmcp";

test.describe("angular tasks", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Task board" })).toBeVisible();
  });

  test("exposes the tools from all three Angular APIs", async ({ webmcp }) => {
    // provideExperimentalWebMcpTools() in app.config.ts.
    await expect(webmcp).toHaveTool("list_tasks", { inputSchema: { properties: { status: { enum: ["open", "done", "all"] } } } });
    // declareExperimentalWebMcpTool() in the Tasks service.
    await expect(webmcp).toHaveTool("complete_task", { inputSchema: { required: ["id"] } });
    // The Signal Forms form: Angular builds the schema from the model, and required() makes a field required.
    await expect(webmcp).toHaveTool("add_task", {
      description: /title and a priority/,
      inputSchema: { properties: { title: { type: "string" }, priority: { type: "string" } }, required: ["title"] },
    });
    // The tool-scoped rules ran in ESLint already. What that could not see is the schema Angular generates for the
    // form at runtime: it has no parameter descriptions, and the form has no way to add them yet.
    await expect(webmcp).toPassLint({ scope: "page", failOn: "warning" });
    const { findings } = await webmcp.lint();
    expect(findings.map((f) => `${f.ruleId} ${f.tool}`).sort()).toEqual(["param-description-missing add_task", "param-description-missing add_task"]);
  });

  test("an agent lists, completes and adds tasks", async ({ page, webmcp }) => {
    const { tasks } = await webmcp.call("list_tasks", {});
    expect(tasks.map((t) => t.title)).toEqual(["Write the release notes", "Review the open pull requests"]);

    expect(await webmcp.call("complete_task", { id: 1 })).toMatchObject({ task: { id: 1, done: true } });
    await expect(page.getByRole("checkbox", { name: "Complete Write the release notes" })).toBeChecked();
    expect(await webmcp.call("complete_task", { id: 99 })).toEqual({ error: "No task has the id 99." });

    // Calling the form tool submits the form; Angular answers in the MCP content shape.
    const added = await webmcp.call("add_task", { title: "Book the venue", priority: "high" });
    expect(added.content[0].text).toBe("Form submitted successfully.");
    await expect(page.getByText("Book the venue")).toBeVisible();

    expect(webmcp).toMatchCalls([
      { functionName: "list_tasks" },
      { functionName: "complete_task" },
      { functionName: "complete_task" },
      { functionName: "add_task" },
    ]);
    // Read-only tools are smoke tested from their schemas.
    await expect(webmcp).toPassSmoke({ tools: ["list_tasks"] });
  });

  test("the form's validation errors reach the agent", async ({ page, webmcp }) => {
    const missingTitle = await webmcp.call("add_task", { title: "", priority: "normal" });
    expect(missingTitle.content[0].text).toBe("Form submission failed:\ntitle: required");
    // required() accepts whitespace; the board would trim it to an empty title, so the form rejects it.
    const blankTitle = await webmcp.call("add_task", { title: "   ", priority: "normal" });
    expect(blankTitle.content[0].text).toBe("Form submission failed:\ntitle: must not be blank");
    await expect(page.locator("li")).toHaveCount(3);

    const badPriority = await webmcp.call("add_task", { title: "Plan the offsite", priority: "urgent" });
    expect(badPriority.content[0].text).toBe("Form submission failed:\npriority: must be low, normal or high");
    await expect(page.getByText("Plan the offsite")).toHaveCount(0);
  });
});
