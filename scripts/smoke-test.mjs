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
    // Volontairement sans await : le sélecteur de page attend une interaction.
    window.planViewer.importPdf('plan-test.pdf', bytes.buffer, { type: 'file' });
  }, pdfBytes);

  // ── Sélecteur de page (document à 2 pages) ────────────────────────────
  await page.waitForFunction(() => document.getElementById('dlg-page').open, null, { timeout: 20_000 });
  const cards = await page.locator('#page-grid .page-card').count();
  check('Sélecteur de page proposé à l’import', cards === 2, `${cards} page(s) proposée(s)`);
  await page.waitForFunction(
    () => document.querySelectorAll('#page-grid .thumb canvas').length === 2,
    null,
    { timeout: 20_000 },
  );
  check('Vignettes des pages rendues', true);

  // On choisit la page 2, pour vérifier que l'import ouvre bien la page demandée.
  await page.locator('#page-grid .page-card').nth(1).click();
  await page.waitForFunction(() => Boolean(window.planViewer.state.plan), null, { timeout: 20_000 });
  check(
    'Page choisie ouverte directement',
    (await page.evaluate(() => window.planViewer.state.layers.pageIndex)) === 1,
  );

  // Le dialogue d'échelle suit immédiatement, pour la page choisie.
  await page.waitForFunction(() => document.getElementById('dlg-scale').open, null, { timeout: 10_000 });
  check(
    'Échelle demandée pour la page choisie',
    (await page.textContent('#scale-page-label')).includes('page 2'),
    await page.textContent('#scale-page-label'),
  );
  await page.evaluate(() => document.getElementById('dlg-scale').close('cancel'));
  check(
    'Échelle non confirmée signalée',
    (await page.textContent('#scale-label')).includes('?'),
    await page.textContent('#scale-label'),
  );

  // Retour sur la page 1 pour la suite des vérifications.
  await page.evaluate(async () => {
    const v = window.planViewer.view;
    await v.setPage(0, { restoreView: false });
    v.layer.scale = { mode: 'ratio', ratio: 50 };
    v.layer.scaleSet = true;
  });
  check('PDF importé et ouvert', true, await page.evaluate(() => window.planViewer.state.plan.name));

  // ── Extraction des tracés vectoriels (accrochage) ─────────────────────
  await page.waitForFunction(() => window.planViewer.view.snapIndex !== null, null, { timeout: 20_000 });
  const segments = await page.evaluate(() => window.planViewer.view.snapIndex.count);
  check('Tracés vectoriels extraits', segments > 0, `${segments} segments`);

  // ── Échelle 1/50 : 600 pt doivent valoir 10,58 m ──────────────────────
  const realMm = await page.evaluate(() => {
    const scale = window.planViewer.view.layer.scale;
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

  const measures = await page.evaluate(() => window.planViewer.view.layer.measures);
  check('Cote créée au geste', measures.length === 1, `${measures.length} cote(s)`);
  if (measures.length === 1) {
    check('Cote contrainte à l’horizontale', Math.abs(measures[0].a.y - measures[0].b.y) < 1e-6);
  }

  // ── Mobilier ──────────────────────────────────────────────────────────
  await page.evaluate(() =>
    window.planViewer.view.addFurniture({ label: 'Canapé', lengthMm: 2000, widthMm: 900, color: '#4da3ff' }),
  );
  const furniture = await page.evaluate(() => window.planViewer.view.layer.furniture);
  check('Meuble ajouté', furniture.length === 1 && furniture[0].lengthMm === 2000);

  // ── Sélection et déplacement au doigt ─────────────────────────────────
  // Règle : un glissement navigue toujours ; seul l'objet déjà sélectionné
  // se déplace. Impossible donc de décaler une cote en voulant se déplacer.
  await page.click('#tool-pan');
  // Départ propre : rien de sélectionné, et le meuble écarté de la cote —
  // les deux se superposaient au centre, et une cote l'emporte volontairement
  // sur un rectangle (sinon une cote posée dessus deviendrait insélectionnable).
  await page.evaluate(() => {
    const v = window.planViewer.view;
    v.select(null);
    Object.assign(v.layer.furniture[0], { cx: 250, cy: 200 });
    v.refresh();
  });
  const item = await page.evaluate(() => {
    const v = window.planViewer.view;
    const f = v.layer.furniture[0];
    const p = v.vp.toScreen(f.cx, f.cy);
    return { screen: p, cx: f.cx, cy: f.cy };
  });
  const canvasBox = await page.locator('#viewport-canvas').boundingBox();
  const at = (o) => ({ x: canvasBox.x + o.x, y: canvasBox.y + o.y });

  // 1. Glissement sur le meuble NON sélectionné : le plan navigue, le meuble
  //    ne bouge pas d'un pouce.
  const before = await page.evaluate(() => ({ ...window.planViewer.view.layer.furniture[0] }));
  let from = at(item.screen);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 90, from.y + 40, { steps: 10 });
  await page.mouse.up();
  const afterPan = await page.evaluate(() => ({ ...window.planViewer.view.layer.furniture[0] }));
  check(
    'Glisser sur un objet non sélectionné navigue, sans le déplacer',
    afterPan.cx === before.cx && afterPan.cy === before.cy,
  );

  // 2. Appui simple sur le meuble : il se sélectionne, l'inspecteur s'ouvre.
  const now = await page.evaluate(() => {
    const v = window.planViewer.view;
    const f = v.layer.furniture[0];
    return v.vp.toScreen(f.cx, f.cy);
  });
  from = at(now);
  await page.mouse.click(from.x, from.y);
  check(
    'Appui simple : objet sélectionné, volet ouvert sur grand écran',
    (await page.evaluate(() => window.planViewer.view.selection?.type)) === 'furniture' &&
      !(await page.locator('#inspector').isHidden()),
  );

  // 3. Glissement sur l'objet sélectionné : cette fois il se déplace.
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + 30, { steps: 10 });
  await page.mouse.up();
  const afterMove = await page.evaluate(() => ({ ...window.planViewer.view.layer.furniture[0] }));
  check(
    'Glisser l’objet sélectionné le déplace',
    Math.abs(afterMove.cx - before.cx) > 1 || Math.abs(afterMove.cy - before.cy) > 1,
  );

  // 4. Rotation 90° et suppression depuis l'inspecteur.
  await page.evaluate(() => window.planViewer.view.rotateSelected(90));
  check('Rotation 90°', (await page.evaluate(() => window.planViewer.view.layer.furniture[0].rot)) === 90);
  await page.evaluate(() => window.planViewer.view.updateSelected({ lengthMm: 1500 }));
  check(
    'Dimensions modifiables',
    (await page.evaluate(() => window.planViewer.view.layer.furniture[0].lengthMm)) === 1500,
  );

  // 5. Appui dans le vide : désélection.
  await page.mouse.click(canvasBox.x + 20, canvasBox.y + canvasBox.height - 20);
  check(
    'Appui dans le vide : désélection',
    (await page.evaluate(() => window.planViewer.view.selection)) === null,
  );

  // On rétablit l'état attendu par la suite des vérifications.
  await page.evaluate(() => {
    const f = window.planViewer.view.layer.furniture[0];
    f.rot = 0;
    f.lengthMm = 2000;
  });

  // ── Poignée de cote : déplacer une extrémité et l'accrocher ───────────
  // Le mur droit du plan de test est en x = 700 : l'extrémité tirée à
  // proximité doit s'y verrouiller exactement.
  const handle = await page.evaluate(() => {
    const v = window.planViewer.view;
    const m = v.layer.measures[0];
    v.select({ type: 'measure', id: m.id });
    return { screen: v.vp.toScreen(m.b.x, m.b.y), bx: m.b.x, target: v.vp.toScreen(700, m.b.y) };
  });
  const grab = at(handle.screen);
  const drop = at(handle.target);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move((grab.x + drop.x) / 2, grab.y, { steps: 8 });
  await page.mouse.move(drop.x - 6, grab.y + 2, { steps: 8 });
  await page.mouse.up();
  const moved = await page.evaluate(() => window.planViewer.view.layer.measures[0]);
  check(
    'Extrémité de cote déplacée et accrochée au mur',
    Math.abs(moved.b.x - 700) < 0.01,
    `x = ${moved.b.x.toFixed(2)} (mur à 700)`,
  );
  check('Extrémité déplacée : la cote reste horizontale', Math.abs(moved.a.y - moved.b.y) < 1e-6);

  // ── Masquage des cotes du mobilier ────────────────────────────────────
  await page.click('#chk-dims');
  check(
    'Bouton « Cotes » : dimensions masquées',
    (await page.evaluate(() => window.planViewer.view.showDimensions)) === false,
  );
  const exportSansCotes = await page.evaluate(async () => {
    const blob = await window.planViewer.buildExport();
    return (await blob.arrayBuffer()).byteLength;
  });
  await page.click('#chk-dims');
  const exportAvecCotes = await page.evaluate(async () => {
    const blob = await window.planViewer.buildExport();
    return (await blob.arrayBuffer()).byteLength;
  });
  check(
    'L’export suit le réglage d’affichage',
    exportSansCotes < exportAvecCotes,
    `${exportSansCotes} o sans cotes, ${exportAvecCotes} o avec`,
  );

  // ── Saisie du nom : le champ ne doit pas être détruit à chaque lettre ──
  // C'est ce qui refermait le clavier de l'iPhone à chaque caractère.
  await page.evaluate(() => {
    const v = window.planViewer.view;
    v.select({ type: 'furniture', id: v.layer.furniture[0].id });
  });
  const nameField = page.locator('#inspector-body input[type="text"]');
  await nameField.click();
  await nameField.fill('');
  await nameField.type('Buffet', { delay: 30 });
  check(
    'Saisie du nom : champ intact et toujours focalisé',
    (await page.evaluate(() => document.activeElement?.type)) === 'text' &&
      (await nameField.inputValue()) === 'Buffet' &&
      (await page.evaluate(() => window.planViewer.view.getSelected().label)) === 'Buffet',
    `champ « ${await nameField.inputValue()} », focus sur ${await page.evaluate(() => document.activeElement?.tagName)}`,
  );

  // ── Persistance IndexedDB ─────────────────────────────────────────────
  await page.evaluate(() => window.planViewer.flushSave());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.planViewer?.state.plan), null, { timeout: 20_000 });
  const restored = await page.evaluate(() => ({
    measures: window.planViewer.view.layer.measures.length,
    furniture: window.planViewer.view.layer.furniture.length,
  }));
  check(
    'Annotations rechargées après redémarrage',
    restored.measures === 1 && restored.furniture === 1,
    JSON.stringify(restored),
  );

  // ── Isolation des calques par page ────────────────────────────────────
  // Un carnet de détails mélange les échelles d'une page à l'autre : les
  // annotations et l'échelle ne doivent jamais déborder sur la page voisine.
  const pageTwo = await page.evaluate(async () => {
    const v = window.planViewer.view;
    await v.setPage(1, { restoreView: false });
    v.layer.scale = { mode: 'ratio', ratio: 10 };
    v.layer.scaleSet = true;
    v.addFurniture({ label: 'Détail', lengthMm: 500, widthMm: 200, color: '#f59e0b' });
    return {
      measures: v.layer.measures.length,
      furniture: v.layer.furniture.length,
      ratio: v.layer.scale.ratio,
    };
  });
  check(
    'Page 2 : calque indépendant',
    pageTwo.measures === 0 && pageTwo.furniture === 1 && pageTwo.ratio === 10,
    JSON.stringify(pageTwo),
  );

  const pageOne = await page.evaluate(async () => {
    const v = window.planViewer.view;
    await v.setPage(0, { restoreView: true });
    return { measures: v.layer.measures.length, furniture: v.layer.furniture.length, ratio: v.layer.scale.ratio };
  });
  check(
    'Page 1 : calque et échelle intacts',
    pageOne.measures === 1 && pageOne.furniture === 1 && pageOne.ratio === 50,
    JSON.stringify(pageOne),
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
  check('PDF exporté relisible', reparsed.getPageCount() === 2, `${reparsed.getPageCount()} page(s)`);
  const [w, h] = [reparsed.getPage(0).getWidth(), reparsed.getPage(0).getHeight()];
  check('Format de page conservé', Math.abs(w - 842) < 1 && Math.abs(h - 595) < 1, `${w}×${h} pt`);

  // ── Service worker ────────────────────────────────────────────────────
  const swVersion = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.active?.scriptURL || reg.installing?.scriptURL || null : null;
  });
  check('Service worker enregistré', Boolean(swVersion), swVersion || 'aucun');

  check('Aucune erreur console', errors.length === 0, errors.slice(0, 3).join(' | '));

  // ── Sans IndexedDB : navigation privée Safari, « Bloquer tous les cookies » ──
  // L'app doit rester utilisable en session temporaire, pas refuser les PDF.
  const privateContext = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  await privateContext.addInitScript(() => {
    // Reproduit le comportement de WebKit : la variable n'existe pas du tout.
    delete window.indexedDB;
    Object.defineProperty(window, 'indexedDB', {
      get() {
        throw new ReferenceError("Can't find variable: indexedDB");
      },
      configurable: true,
    });
  });
  const privatePage = await privateContext.newPage();
  const privateErrors = [];
  privatePage.on('pageerror', (err) => privateErrors.push(err.message));
  await privatePage.goto(URL, { waitUntil: 'networkidle' });
  await privatePage.waitForFunction(() => Boolean(window.planViewer?.view), null, { timeout: 15_000 });

  check(
    'Sans IndexedDB : avertissement affiché',
    (await privatePage.textContent('#status-save')).includes('Session temporaire'),
    await privatePage.textContent('#status-save'),
  );

  await privatePage.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    window.planViewer.importPdf('sans-stockage.pdf', bytes.buffer, { type: 'file' });
  }, pdfBytes);
  await privatePage.waitForFunction(() => document.getElementById('dlg-page').open, null, { timeout: 20_000 });
  await privatePage.locator('#page-grid .page-card').nth(0).click();
  await privatePage.waitForFunction(() => Boolean(window.planViewer.state.plan), null, { timeout: 20_000 });
  await privatePage.evaluate(() => document.getElementById('dlg-scale').close('cancel'));
  check('Sans IndexedDB : le PDF s’ouvre quand même', true);

  await privatePage.waitForFunction(() => window.planViewer.view.snapIndex !== null, null, { timeout: 20_000 });
  await privatePage.evaluate(() =>
    window.planViewer.view.addFurniture({ label: 'Test', lengthMm: 1000, widthMm: 500, color: '#22c55e' }),
  );
  const privateExport = await privatePage.evaluate(async () => {
    const blob = await window.planViewer.buildExport();
    return (await blob.arrayBuffer()).byteLength;
  });
  check('Sans IndexedDB : mesure et export fonctionnent', privateExport > 1000, `${privateExport} octets`);
  check(
    'Sans IndexedDB : aucune erreur fatale',
    privateErrors.length === 0,
    privateErrors.slice(0, 2).join(' | '),
  );
  await privateContext.close();

  // ── iPhone : la barre d'état ne doit jamais changer de hauteur ─────────
  // Un nom de plan long qui passe de 2 à 3 lignes quand « Enregistré »
  // apparaît redimensionne la zone de rendu, ce qui fait sauter tout l'écran
  // et provoque un flash noir sur le canvas.
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const phonePage = await phone.newPage();
  await phonePage.goto(URL, { waitUntil: 'networkidle' });
  await phonePage.waitForFunction(() => Boolean(window.planViewer?.view), null, { timeout: 15_000 });
  // Contexte neuf : sa base est vide, il faut y réimporter un plan.
  await phonePage.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    window.planViewer.importPdf('plan-test.pdf', bytes.buffer, { type: 'file' });
  }, pdfBytes);
  await phonePage.waitForFunction(() => document.getElementById('dlg-page').open, null, { timeout: 20_000 });
  await phonePage.locator('#page-grid .page-card').nth(0).click();
  await phonePage.waitForFunction(() => Boolean(window.planViewer.state.plan), null, { timeout: 20_000 });
  // Le dialogue d'échelle s'ouvre juste après l'import : attendre qu'il soit là
  // avant de le fermer, sinon il reste ouvert et bloque tous les clics.
  await phonePage.waitForFunction(() => document.getElementById('dlg-scale').open, null, { timeout: 15_000 });
  await phonePage.evaluate(() => document.getElementById('dlg-scale').close('cancel'));
  await phonePage.waitForFunction(() => window.planViewer.view.snapIndex !== null, null, { timeout: 20_000 });

  const heights = await phonePage.evaluate(async () => {
    const bar = document.getElementById('statusbar');
    const stage = document.getElementById('stage');
    const save = document.getElementById('status-save');
    const seen = new Set();
    const record = () => seen.add(`${bar.offsetHeight}/${stage.offsetHeight}`);

    // Nom très long, comme « 01 Plan B2 - Appart 305.pdf · 6 128 tracés ».
    document.querySelector('#status-doc .doc-name').textContent =
      '01 Plan B2 - Appart 305 niveau R+2 version def.pdf';
    document.querySelector('#status-doc .doc-meta').textContent = ' · page 1/3 · 6 128 tracés';
    record();

    for (const text of ['', 'Échec de sauvegarde', '', 'Session temporaire']) {
      save.textContent = text;
      await new Promise((r) => requestAnimationFrame(r));
      record();
    }
    return [...seen];
  });
  check(
    'iPhone : hauteur de la barre d’état constante',
    heights.length === 1,
    heights.join(' · '),
  );

  // ── iPhone : le volet d'édition s'ouvre replié ────────────────────────
  // La barre est remise dans son état normal : le test précédent y avait
  // laissé un avertissement artificiel.
  await phonePage.evaluate(() => {
    document.getElementById('status-save').textContent = '';
  });
  const phoneItem = await phonePage.evaluate(() => {
    const v = window.planViewer.view;
    v.select(null);
    const item = v.addFurniture({ label: 'Lit', lengthMm: 1400, widthMm: 1900, color: '#4da3ff' });
    v.select(null);
    return v.vp.toScreen(item.cx, item.cy);
  });
  const phoneBox = await phonePage.locator('#viewport-canvas').boundingBox();
  await phonePage.mouse.click(phoneBox.x + phoneItem.x, phoneBox.y + phoneItem.y);
  check(
    'iPhone : sélection repliée, pastille affichée',
    (await phonePage.evaluate(() => window.planViewer.view.selection?.type)) === 'furniture' &&
      (await phonePage.locator('#inspector').isHidden()) &&
      !(await phonePage.locator('#btn-inspector').isHidden()),
  );
  check(
    'iPhone : la pastille nomme l’objet',
    (await phonePage.textContent('#inspector-chip-label')) === 'Lit',
    await phonePage.textContent('#inspector-chip-label'),
  );

  await phonePage.click('#btn-inspector');
  check(
    'iPhone : la pastille déplie le volet',
    !(await phonePage.locator('#inspector').isHidden()) &&
      (await phonePage.getAttribute('#btn-inspector', 'aria-expanded')) === 'true',
  );

  await phonePage.click('#inspector-close');
  check(
    'iPhone : replier ne désélectionne pas',
    (await phonePage.locator('#inspector').isHidden()) &&
      (await phonePage.evaluate(() => window.planViewer.view.selection?.type)) === 'furniture',
  );
  await phonePage.evaluate(() => window.planViewer.view.select(null));

  // Le canvas ne doit jamais rester noir après un redimensionnement.
  const repaint = await phonePage.evaluate(() => {
    const v = window.planViewer.view;
    const canvas = document.getElementById('viewport-canvas');
    const stage = document.getElementById('stage');
    stage.style.height = `${stage.offsetHeight - 24}px`;
    v.resize(); // synchrone : le repaint doit avoir eu lieu au retour
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1);
    stage.style.height = '';
    return { r: data[0], g: data[1], b: data[2] };
  });
  check(
    'Redimensionnement : pas de canvas noir',
    repaint.r + repaint.g + repaint.b > 60,
    `pixel central rgb(${repaint.r},${repaint.g},${repaint.b})`,
  );
  await phone.close();
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} vérifications réussies.`);
process.exit(failed.length === 0 ? 0 : 1);
