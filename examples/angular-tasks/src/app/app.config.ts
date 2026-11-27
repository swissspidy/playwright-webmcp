import { ApplicationConfig, inject, provideExperimentalWebMcpTools } from "@angular/core";
import { provideExperimentalWebMcpForms } from "@angular/forms/signals";
import { Tasks } from "./tasks";

export const appConfig: ApplicationConfig = {
  providers: [
    // Signal Forms created with `experimentalWebMcpTool` register as tools (see app.ts).
    provideExperimentalWebMcpForms(),
    // Tools that live as long as the app. `execute` runs in the injection context, so it can inject().
    provideExperimentalWebMcpTools([
      {
        name: "list_tasks",
        title: "List tasks",
        description: "Lists the tasks on the board with their id, title, priority and whether they are done. Open tasks only unless a status is given.",
        inputSchema: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["open", "done", "all"], description: "Which tasks to list. Defaults to open." },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: ({ status }) => ({ tasks: inject(Tasks).list(status ?? "open") }),
      },
    ]),
  ],
};
