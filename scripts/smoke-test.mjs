/**
 * Test de fumée : build → serveur de prévisualisation → parcours complet dans
 * Chromium (import PDF, extraction vectorielle, mesure au geste, export annoté).
 *
 * Ne remplace pas les tests sur iPad réel — les gestes tactiles et les limites
 * mémoire ne se reproduisent pas fidèlement sur ordinateur — mais il attrape
 * les régressions de bout en bout.
 *
 *   npm run build && npm run test:smoke
 */

import { spawn } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { launchBrowser } from './browser.mjs';
import { makeTestPlan } from './make-test-plan.mjs';

const PORT = 4173;
const URL = `http://localhost:${PORT}/`;

const checks = [];
function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail });
  console.log(`${condition ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(URL);
      if (res.ok) return;
    } catch {
      /* pas encore démarré */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Le serveur de prévisualisation n’a pas démarré.');
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: 'ignore',
  detached: false,
});

let browser;
try {
  await waitForServer();

  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.planViewer?.view), null, { timeout: 15_000 });
  check('Application démarrée', true);

  // ── Import d'un PDF vectoriel ─────────────────────────────────────────
  const pdfBytes = Buffer.from(await makeTestPlan()).toString('base64');
  await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await window.planViewer.importPdf('plan-test.pdf', bytes.buffer, { type: 'file' });
    // Le dialogue d'échelle s'ouvre automatiquement après l'import.
    document.getElementById('dlg-scale')?.close('cancel');
  }, pdfBytes);

  await page.waitForFunction(() => Boolean(window.planViewer.state.plan), null, { timeout: 20_000 });
  check('PDF importé et ouvert', true, await page.evaluate(() => window.planViewer.state.plan.name));

  // ── Extraction des tracés vectoriels (accrochage) ─────────────────────
  await page.waitForFunction(() => window.planViewer.view.snapIndex !== null, null, { timeout: 20_000 });
  const segments = await page.evaluate(() => window.planViewer.view.snapIndex.count);
  check('Tracés vectoriels extraits', segments > 0, `${segments} segments`);

  // ── Échelle 1/50 : 600 pt doivent valoir 10,58 m ──────────────────────
  const realMm = await page.evaluate(() => {
    const { mmPerPt } = window.planViewer.state.layers.scale.mode === 'ratio' ? {} : {};
    void mmPerPt;
    const scale = window.planViewer.state.layers.scale;
    return 600 * (25.4 / 72) * scale.ratio;
  });
  check('Conversion d’échelle correcte', Math.abs(realMm - 10583.3) < 1, `${(realMm / 1000).toFixed(2)} m`);

  // ── Mesure tracée au geste (souris = PointerEvent) ────────────────────
  await page.click('#tool-measure');
  const box = await page.locator('#viewport-canvas').boundingBox();
  const y = box.y + box.height * 0.5;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, y + 3, { steps: 8 });
  await page.mouse.move(box.x + box.width * 0.6, y + 2, { steps: 8 });
  await page.mouse.up();

  const measures = await page.evaluate(() => window.planViewer.state.layers.measures);
  check('Cote créée au geste', measures.length === 1, `${measures.length} cote(s)`);
  if (measures.length === 1) {
    check('Cote contrainte à l’horizontale', Math.abs(measures[0].a.y - measures[0].b.y) < 1e-6);
  }

  // ── Mobilier ──────────────────────────────────────────────────────────
  await page.evaluate(() =>
    window.planViewer.view.addFurniture({ label: 'Canapé', lengthMm: 2000, widthMm: 900, color: '#4da3ff' }),
  );
  const furniture = await page.evaluate(() => window.planViewer.state.layers.furniture);
  check('Meuble ajouté', furniture.length === 1 && furniture[0].lengthMm === 2000);

  // ── Persistance IndexedDB ─────────────────────────────────────────────
  // La sauvegarde est différée : on attend qu'elle soit effectivement écrite.
  await page.waitForFunction(() => document.getElementById('status-save').textContent === 'Enregistré', null, {
    timeout: 10_000,
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.planViewer?.state.plan), null, { timeout: 20_000 });
  const restored = await page.evaluate(() => ({
    measures: window.planViewer.state.layers.measures.length,
    furniture: window.planViewer.state.layers.furniture.length,
  }));
  check(
    'Annotations rechargées après redémarrage',
    restored.measures === 1 && restored.furniture === 1,
    JSON.stringify(restored),
  );

  // ── Export PDF annoté ─────────────────────────────────────────────────
  const exported = await page.evaluate(async () => {
    const blob = await window.planViewer.buildExport();
    const buffer = await blob.arrayBuffer();
    return Array.from(new Uint8Array(buffer));
  });
  const exportedBytes = Uint8Array.from(exported);
  check('Export PDF non vide', exportedBytes.length > 1000, `${exportedBytes.length} octets`);
  const reparsed = await PDFDocument.load(exportedBytes);
  check('PDF exporté relisible', reparsed.getPageCount() === 1);
  const [w, h] = [reparsed.getPage(0).getWidth(), reparsed.getPage(0).getHeight()];
  check('Format de page conservé', Math.abs(w - 842) < 1 && Math.abs(h - 595) < 1, `${w}×${h} pt`);

  // ── Service worker ────────────────────────────────────────────────────
  const swVersion = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.active?.scriptURL || reg.installing?.scriptURL || null : null;
  });
  check('Service worker enregistré', Boolean(swVersion), swVersion || 'aucun');

  check('Aucune erreur console', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} vérifications réussies.`);
process.exit(failed.length === 0 ? 0 : 1);
