/**
 * Names of the Playwright test attachments the `playwright-webmcp` fixture
 * writes and the `playwright-webmcp-evals` reporter reads. Kept here so the
 * two packages share one definition without depending on each other.
 */
export const ATTACHMENTS = {
  eval: "webmcp-eval",
  tools: "webmcp-tools",
  lint: "webmcp-lint",
  snapshot: "webmcp-snapshot",
  calls: "webmcp-calls",
  promptApi: "webmcp-prompt-api",
  smoke: "webmcp-smoke",
  contract: "webmcp-contract",
  toolSnapshots: "webmcp-tool-snapshots",
  timeline: "webmcp-timeline",
} as const;

export type AttachmentName = (typeof ATTACHMENTS)[keyof typeof ATTACHMENTS];
