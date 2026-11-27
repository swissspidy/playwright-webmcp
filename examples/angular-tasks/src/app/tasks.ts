import { Injectable, declareExperimentalWebMcpTool, signal } from "@angular/core";

export type Priority = "low" | "normal" | "high";

export interface Task {
  id: number;
  title: string;
  priority: Priority;
  done: boolean;
}

/** The board's state. Created once, at the root, by the first component that injects it. */
@Injectable({ providedIn: "root" })
export class Tasks {
  private nextId = 4;
  readonly all = signal<Task[]>([
    { id: 1, title: "Write the release notes", priority: "high", done: false },
    { id: 2, title: "Review the open pull requests", priority: "normal", done: false },
    { id: 3, title: "Update the dependencies", priority: "low", done: true },
  ]);

  constructor() {
    // A tool declared in an injection context lives as long as it: for a root service, as long as the app.
    // The ESLint plugin lints this literal like any registerTool() call.
    declareExperimentalWebMcpTool({
      name: "complete_task",
      title: "Complete a task",
      description: "Marks a task on the board as done, by its id. Use list_tasks first to find the id. Returns the task, or an error when no task has that id.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "integer", description: "The id of the task, as list_tasks returns it." } },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, consequentialHint: false },
      execute: ({ id }) => {
        const task = this.complete(id);
        return task ? { task } : { error: `No task has the id ${id}.` };
      },
    });
  }

  list(status: "open" | "done" | "all"): Task[] {
    return this.all().filter((t) => status === "all" || t.done === (status === "done"));
  }

  add(title: string, priority: Priority): Task {
    const task: Task = { id: this.nextId++, title: title.trim(), priority, done: false };
    this.all.update((tasks) => [...tasks, task]);
    return task;
  }

  complete(id: number): Task | undefined {
    let found: Task | undefined;
    this.all.update((tasks) => tasks.map((t) => (t.id === id ? (found = { ...t, done: true }) : t)));
    return found;
  }
}
