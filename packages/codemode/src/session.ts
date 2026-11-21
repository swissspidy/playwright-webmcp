import type { CdpLikeSession } from "./registry.js";

/** The parts of a Playwright or Puppeteer page used to open a CDP session. */
export type PageLike = { context(): { newCDPSession(page: any): Promise<CdpLikeSession> } } | { createCDPSession(): Promise<CdpLikeSession> };

export async function sessionFor(target: PageLike | CdpLikeSession): Promise<CdpLikeSession> {
  const t = target as any;
  // A CDP session already (Playwright CDPSession, Puppeteer CDPSession, chrome-remote-interface wrappers).
  if (typeof t.send === "function" && typeof t.on === "function") return t;
  // Playwright: page.context().newCDPSession(page). Chromium only.
  if (typeof t.context === "function") {
    const context = t.context();
    if (typeof context?.newCDPSession === "function") return context.newCDPSession(t);
  }
  // Puppeteer: page.createCDPSession().
  if (typeof t.createCDPSession === "function") return t.createCDPSession();
  throw new TypeError("Expected a Playwright page, a Puppeteer page, or a CDP session with send() and on()");
}
