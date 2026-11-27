import { Component, inject, signal } from "@angular/core";
import { FormField, FormRoot, form, required, validate } from "@angular/forms/signals";
import { Tasks, type Priority } from "./tasks";

const PRIORITIES: readonly string[] = ["low", "normal", "high"];

const EMPTY = { title: "", priority: "normal" as Priority };

@Component({
  selector: "app-root",
  imports: [FormField, FormRoot],
  template: `
    <h1>Task board</h1>
    <ul>
      @for (task of tasks.all(); track task.id) {
        <li [class.done]="task.done">
          <input type="checkbox" [checked]="task.done" [disabled]="task.done" (change)="tasks.complete(task.id)" [attr.aria-label]="'Complete ' + task.title" />
          <span>{{ task.title }}</span>
          <small>{{ task.priority }}</small>
        </li>
      }
    </ul>
    <form [formRoot]="taskForm">
      <label>Title <input [formField]="taskForm.title" /></label>
      <label>
        Priority
        <select [formField]="taskForm.priority">
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
        </select>
      </label>
      <button type="submit">Add task</button>
    </form>
  `,
})
export class App {
  protected readonly tasks = inject(Tasks);
  protected readonly draft = signal({ ...EMPTY });

  // The form is a tool too: Angular builds its input schema from the model and submits the form when an agent calls it,
  // so validation errors reach the agent as they would a person. The ESLint plugin lints the name and description.
  protected readonly taskForm = form(
    this.draft,
    (path) => {
      required(path.title);
      // Angular's generated schema says only "string" for a select, so an agent can send anything; reject the rest.
      validate(path.priority, ({ value }) => (PRIORITIES.includes(value()) ? undefined : { kind: "priority", message: "must be low, normal or high" }));
    },
    {
      experimentalWebMcpTool: {
        name: "add_task",
        description: "Adds a task to the board with a title and a priority of low, normal or high. The title is required.",
      },
      submission: {
        action: async (field) => {
          const { title, priority } = field().value();
          this.tasks.add(title, priority);
          this.draft.set({ ...EMPTY });
          return undefined;
        },
      },
    },
  );
}
