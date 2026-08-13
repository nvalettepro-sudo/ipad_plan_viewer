/**
 * Génère les icônes PNG de la PWA à partir de `scripts/icon.svg`.
 *
 * Les PNG produits sont versionnés dans le dépôt : ce script n'est à relancer
 * que si le dessin change (`npm run icons`). Il utilise Chromium via Playwright
 * pour rastériser le SVG.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'scripts', 'icon.svg'), 'utf8');
const outDir = join(root, 'public', 'icons');

/**
 * `maskable` : Android/Chrome recadre l'icône, il faut donc que le dessin tienne
 * dans le cercle de sécurité (80 % du côté). On ajoute une marge en dézoomant.
 */
const TARGETS = [
  { file: 'icon-192.png', size: 192, padding: 0 },
  { file: 'icon-512.png', size: 512, padding: 0 },
  { file: 'icon-maskable-512.png', size: 512, padding: 0.16 },
  { file: 'apple-touch-icon.png', size: 180, padding: 0 },
  { file: 'favicon.png', size: 64, padding: 0 },
];

const page = (size, padding) => `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: #0d1622; }
  #wrap { width: ${size}px; height: ${size}px; overflow: hidden; background: #0d1622; }
  svg { display: block; width: ${size}px; height: ${size}px; transform: scale(${1 - padding * 2}); transform-origin: center; }
</style>
<div id="wrap">${svg}</div>`;

const browser = await launchBrowser();
mkdirSync(outDir, { recursive: true });

for (const { file, size, padding } of TARGETS) {
  const tab = await browser.newPage({ viewport: { width: size, height: size } });
  await tab.setContent(page(size, padding));
  const buffer = await tab.locator('#wrap').screenshot({ omitBackground: false });
  writeFileSync(join(outDir, file), buffer);
  await tab.close();
  console.log(`✓ ${file} (${size}px)`);
}

await browser.close();
