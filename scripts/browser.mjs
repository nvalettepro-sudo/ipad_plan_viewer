/**
 * Lancement de Chromium pour les scripts outillés (icônes, test de fumée).
 *
 * `PLAYWRIGHT_CHROMIUM_PATH` permet d'utiliser un Chromium déjà présent sur la
 * machine plutôt que celui téléchargé par Playwright.
 */

import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const CANDIDATES = [
  process.env.PLAYWRIGHT_CHROMIUM_PATH,
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);

export function launchBrowser(options = {}) {
  const executablePath = CANDIDATES.find((p) => existsSync(p));
  return chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(executablePath ? { executablePath } : {}),
    ...options,
  });
}
