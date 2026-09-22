/**
 * Which shape `executeTool()` accepts for its input. The specification says an
 * object. Chrome 154 and earlier accepted only a JSON string; Chrome 155
 * deprecated the string and later builds reject it. The wrong shape is
 * refused while arguments are validated, before the tool runs, but a refused
 * attempt still shows up as an invocation on the CDP domain, so the shape is
 * decided from the browser version rather than by trying both.
 */
export type ExecuteToolInputShape = "object" | "string";

const CHROME_155 = 155;

/** Major Chromium version from `browser.version()` (`"153.0.8010.12"`) or a user agent string, when it is Chromium. */
export function chromiumMajor(version: string | undefined): number | undefined {
  if (!version) return undefined;
  const m = /(?:^|Chrome\/|Chromium\/)(\d{2,3})\.\d+/.exec(version);
  return m ? Number(m[1]) : undefined;
}

export function executeToolInputShape(version: string | undefined): ExecuteToolInputShape {
  const major = chromiumMajor(version);
  return major !== undefined && major < CHROME_155 ? "string" : "object";
}
