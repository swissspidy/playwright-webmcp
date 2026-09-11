/**
 * Names of the Playwright test attachments the `playwright-webmcp` fixture
 * writes and its reporter (`playwright-webmcp/reporter`) reads.
 */
export const ATTACHMENTS = {
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
