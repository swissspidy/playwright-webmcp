import { chromium } from "playwright";
import { CodeMode } from "@swissspidy/webmcp-codemode";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1248/chrome-linux64/chrome", args: ["--enable-features=WebMCP"] });
for (const demo of process.argv.slice(2)) {
  const page = await browser.newPage();
  await page.goto(`https://googlechromelabs.github.io/webmcp-tools/demos/${demo}/`);
  const cm = await CodeMode.create(page);
  console.log(`\n===== ${demo} ${page.url()}`);
  for (const t of cm.registry.list()) console.log(`- ${t.name}: ${t.description.slice(0, 220).replace(/\s+/g, " ")}\n    ${JSON.stringify(t.inputSchema).slice(0, 400)}`);
  await page.close();
}
await browser.close();
