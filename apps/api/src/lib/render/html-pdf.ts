// TP-9 — HTML → PDF via headless Chromium (playwright-core; no bundled
// browser download). Launch resolution order: PLAYWRIGHT_CHROMIUM_PATH
// env → /opt/pw-browsers/chromium (this appliance's preinstalled build)
// → playwright-core's default discovery. Docker-image implications are
// documented in docs/planning-module.md.
import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import { logger } from '../logger.js';

let browserPromise: Promise<Browser> | null = null;

function resolveExecutablePath(): string | undefined {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (existsSync('/opt/pw-browsers/chromium')) return '/opt/pw-browsers/chromium';
  return undefined;
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const executablePath = resolveExecutablePath();
      try {
        return await chromium.launch({
          headless: true,
          executablePath,
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        });
      } catch (err) {
        browserPromise = null;
        throw err;
      }
    })();
  }
  return browserPromise;
}

/** Cheap capability probe so tests can skip cleanly off-appliance. */
export async function chromiumAvailable(): Promise<boolean> {
  try {
    await getBrowser();
    return true;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'chromium unavailable for pdf rendering');
    return false;
  }
}

export async function htmlToPdf(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle' });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    await b?.close();
  }
}
