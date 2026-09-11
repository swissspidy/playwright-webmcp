/**
 * Ambient typings for the WebMCP API surface used by tests and the fixture.
 * These follow the WebMCP explainer and are intentionally loose.
 */
export interface WebMCPToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown> | null;
  annotations?: Record<string, unknown>;
  execute?: (args: any, options?: { signal?: AbortSignal }) => unknown | Promise<unknown>;
}

export interface WebMCPRegisteredTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown> | null;
  annotations?: Record<string, unknown>;
  origin: string;
  window?: Window;
  execute?: (args: any, options?: { signal?: AbortSignal }) => unknown | Promise<unknown>;
  /** Origins the tool was exposed to at registration, when the implementation surfaces it (the test shim does). */
  exposedTo?: string[];
}

export interface WebMCPModelContext extends EventTarget {
  registerTool(tool: WebMCPToolDefinition, options?: { signal?: AbortSignal; exposedTo?: string[] }): Promise<void>;
  unregisterTool?(name: string): void;
  provideContext?(context: { tools: WebMCPToolDefinition[] }): Promise<void>;
  clearContext?(): void;
  getTools(options?: { fromOrigins?: string[] }): Promise<WebMCPRegisteredTool[]>;
  executeTool(tool: WebMCPRegisteredTool | string, args: unknown, options?: Record<string, unknown>): Promise<unknown>;
  ontoolchange?: ((event: Event) => void) | null;
}

declare global {
  interface Document {
    modelContext?: WebMCPModelContext;
  }
  interface Navigator {
    modelContext?: WebMCPModelContext;
  }
}
