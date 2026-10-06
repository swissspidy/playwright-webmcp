---
"@swissspidy/webmcp-audit": minor
---

Drop the agent-readiness score from the audit. `AuditReport.score` and `PageAudit.score` are gone, and the Markdown report and CLI progress no longer print a score. Lighthouse's Agentic Browsing category now scores a page's WebMCP setup; the audit focuses on what a single-page report does not cover: calling tools, cross-page drift, baseline comparisons, and every frame against the full rule set. `computeScore()` and `toHaveAgentReadinessScore()` in the other packages are unchanged.
