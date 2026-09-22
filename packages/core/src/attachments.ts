/**
 * Names of the Playwright test attachments the `@swissspidy/playwright-webmcp`
 * fixture writes and its reporter (`@swissspidy/playwright-webmcp/reporter`)
 * reads. These are identifiers in the attachment format, not package names, so
 * they stay unscoped alongside the rest of the `webmcp-*` family.
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
