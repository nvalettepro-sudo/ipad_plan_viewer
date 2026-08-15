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

/**
 * Les commandes secondaires vivent dans le menu burger : il faut l'ouvrir avant
 * de cliquer, et attendre sa fermeture avant la vérification suivante.
 */
async function menuClick(page, selector) {
  await page.click('#btn-menu');
  await page.waitForFunction(() => document.getElementById('dlg-menu').open, null, { timeout: 5_000 });
  await page.click(selector);
  await page.waitForFunction(() => !document.getElementById('dlg-menu').open, null, { timeout: 5_000 });
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
  // Les lignes verticales du plan de test sont en x = 100, 400 et 700. Une
  // cote tracée grossièrement doit voir ses DEUX extrémités s'y verrouiller,
  // chacune sur la ligne la plus proche du doigt.
  const walls = [100, 400, 700];
  const onWall = (x) => walls.some((w) => Math.abs(x - w) < 0.01);
  check(
    'Les deux extrémités se posent sur un trait',
    measures.length === 1 && onWall(measures[0].a.x) && onWall(measures[0].b.x),
    measures.length === 1 ? `x = ${measures[0].a.x.toFixed(1)} → ${measures[0].b.x.toFixed(1)}` : '',
  );
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

  // ── Étiquettes qui débordent : elles disparaissent ────────────────────
  // Les étiquettes gardent une taille fixe à l'écran. En dézoomant elles
  // finiraient par être plus grandes que ce qu'elles décrivent et masqueraient
  // le plan : on vérifie qu'elles s'effacent au lieu de grossir en apparence.
  // On espionne `fillText` : le rendu du PDF est un bitmap recomposé, seules
  // les annotations écrivent du texte pendant un repaint.
  await page.evaluate(() => {
    const proto = CanvasRenderingContext2D.prototype;
    const original = proto.fillText;
    window.__paintedText = [];
    proto.fillText = function (text, ...rest) {
      window.__paintedText.push(String(text));
      return original.call(this, text, ...rest);
    };
  });

  /** Repeint et renvoie les textes effectivement écrits sur le canevas. */
  const paintedText = async () => {
    await page.evaluate(() => {
      window.__paintedText = [];
      window.planViewer.view.refresh();
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    return page.evaluate(() => window.__paintedText);
  };

  // Une cote courte (20 pt ≈ 35 cm à 1/50) en plus de la longue déjà tracée :
  // c'est elle qui perd son étiquette la première.
  await page.evaluate(() => {
    const v = window.planViewer.view;
    v.select(null);
    Object.assign(v.layer.furniture[0], { label: 'Canapé', lengthMm: 2000, widthMm: 900, rot: 0 });
    v.layer.measures.push({
      id: 'courte',
      type: 'measure',
      a: { x: 200, y: 480 },
      b: { x: 220, y: 480 },
      axis: 'h',
    });
    v.fit();
  });

  // Zoom maximal : tout tient, tout s'affiche.
  await page.evaluate(() => {
    for (let i = 0; i < 10; i++) window.planViewer.view.zoomBy(1.5);
  });
  const zoomedIn = await paintedText();
  check(
    'Zoom fort : nom et dimensions du meuble affichés',
    zoomedIn.includes('Canapé') && zoomedIn.some((t) => t.includes('×')),
    zoomedIn.join(' | ') || '(aucun texte)',
  );
  check(
    'Zoom fort : la cote courte affiche sa valeur',
    zoomedIn.some((t) => t === '35 cm'),
    zoomedIn.join(' | '),
  );

  // Zoom minimal : ni le rectangle ni la cote courte n'ont la place. La cote
  // de 10 m, elle, reste bien plus longue que son étiquette : elle la garde.
  await page.evaluate(() => {
    window.planViewer.view.fit();
    for (let i = 0; i < 10; i++) window.planViewer.view.zoomBy(1 / 1.5);
  });
  const zoomedOut = await paintedText();
  check(
    'Dézoom : le meuble n’affiche plus de texte géant',
    !zoomedOut.includes('Canapé') && !zoomedOut.some((t) => t.includes('×')),
    zoomedOut.join(' | ') || '(aucun texte)',
  );
  check(
    'Dézoom : la cote courte perd son étiquette, la longue la garde',
    !zoomedOut.includes('35 cm') && zoomedOut.some((t) => t.includes('10,58')),
    zoomedOut.join(' | ') || '(aucun texte)',
  );

  // Place intermédiaire : le nom prime sur les dimensions. Le rectangle est
  // réduit à une hauteur qui n'admet qu'une seule ligne d'étiquette.
  await page.evaluate(() => {
    const v = window.planViewer.view;
    v.fit();
    const f = v.layer.furniture[0];
    // On vise 32 px de haut à l'écran : de quoi loger une étiquette (20 px),
    // pas deux. Calculé depuis le zoom courant pour ne pas dépendre du
    // format de la fenêtre de test.
    const px = v.vp.lengthToScreen(f.widthMm / ((25.4 / 72) * v.layer.scale.ratio));
    Object.assign(f, { label: 'Lit', lengthMm: 2000, widthMm: Math.round((f.widthMm * 32) / px) });
  });
  const middle = await paintedText();
  check(
    'Place réduite : le nom reste, les dimensions tombent',
    middle.includes('Lit') && !middle.some((t) => t.includes('×')),
    middle.join(' | ') || '(aucun texte)',
  );

  // Retour à l'état attendu par la suite des vérifications.
  await page.evaluate(() => {
    const v = window.planViewer.view;
    Object.assign(v.layer.furniture[0], { label: 'Canapé', lengthMm: 2000, widthMm: 900 });
    v.layer.measures = v.layer.measures.filter((m) => m.id !== 'courte');
    v.fit();
  });

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

  // ── Meuble plaqué contre un mur ───────────────────────────────────────
  // Le mur gauche du plan de test est en x = 100. Lâché un peu à droite, le
  // meuble doit voir son arête gauche se coller exactement dessus.
  const wallSnap = await page.evaluate(() => {
    const v = window.planViewer.view;
    const f = v.layer.furniture[0];
    // y = 420 : à l'écart de la cote existante (y ≈ 297) et du refend, sinon
    // c'est la cote qui capte la sélection et le glissement se met à naviguer.
    Object.assign(f, { rot: 0, lengthMm: 2000, widthMm: 900, cx: 300, cy: 420 });
    v.select({ type: 'furniture', id: f.id });
    v.refresh();
    return v.vp.toScreen(f.cx, f.cy);
  });
  const grabItem = at(wallSnap);
  // Cible : arête gauche à ~4 pt du mur, donc dans le rayon d'attraction.
  const wallTarget = await page.evaluate(() => {
    const v = window.planViewer.view;
    const f = v.layer.furniture[0];
    const perMm = 1 / (25.4 / 72) / v.layer.scale.ratio;
    const halfWidth = (f.lengthMm * perMm) / 2;
    return v.vp.toScreen(100 + halfWidth + 4, f.cy);
  });
  const dropItem = at(wallTarget);
  await page.mouse.move(grabItem.x, grabItem.y);
  await page.mouse.down();
  await page.mouse.move((grabItem.x + dropItem.x) / 2, grabItem.y, { steps: 8 });
  await page.mouse.move(dropItem.x, dropItem.y, { steps: 8 });
  await page.mouse.up();

  const placed = await page.evaluate(() => {
    const v = window.planViewer.view;
    const f = v.layer.furniture[0];
    const perMm = 1 / (25.4 / 72) / v.layer.scale.ratio;
    return { left: f.cx - (f.lengthMm * perMm) / 2, cy: f.cy };
  });
  check(
    'Meuble plaqué contre le mur',
    Math.abs(placed.left - 100) < 0.01,
    `arête gauche à x = ${placed.left.toFixed(2)} (mur à 100)`,
  );

  // ── Meuble accroché à un autre meuble ─────────────────────────────────
  // Deux meubles doivent pouvoir se poser bord à bord, exactement, sans
  // laisser le filet de blanc qu'un placement à l'œil laisse toujours.
  const pairTarget = await page.evaluate(() => {
    const v = window.planViewer.view;
    const perMm = 1 / (25.4 / 72) / v.layer.scale.ratio;
    const first = v.layer.furniture[0];
    const rightEdge = first.cx + (first.lengthMm * perMm) / 2;
    // Second meuble posé à droite du premier, en le manquant de 5 pt : c'est
    // à l'accrochage de finir le travail.
    const second = v.addFurniture({ label: 'Table', lengthMm: 1200, widthMm: 600, color: '#22c55e' });
    Object.assign(second, { cx: 600, cy: first.cy, rot: 0 });
    v.select({ type: 'furniture', id: second.id });
    v.refresh();
    return {
      grab: v.vp.toScreen(second.cx, second.cy),
      drop: v.vp.toScreen(rightEdge + (second.lengthMm * perMm) / 2 + 5, first.cy),
      rightEdge,
    };
  });
  const grabPair = at(pairTarget.grab);
  const dropPair = at(pairTarget.drop);
  await page.mouse.move(grabPair.x, grabPair.y);
  await page.mouse.down();
  await page.mouse.move((grabPair.x + dropPair.x) / 2, grabPair.y, { steps: 8 });
  await page.mouse.move(dropPair.x, dropPair.y, { steps: 8 });
  await page.mouse.up();
  const pair = await page.evaluate(() => {
    const v = window.planViewer.view;
    const perMm = 1 / (25.4 / 72) / v.layer.scale.ratio;
    const [a, b] = v.layer.furniture;
    return {
      aRight: a.cx + (a.lengthMm * perMm) / 2,
      bLeft: b.cx - (b.lengthMm * perMm) / 2,
    };
  });
  check(
    'Meuble posé bord à bord contre un autre meuble',
    Math.abs(pair.bLeft - pair.aRight) < 0.01,
    `arête gauche à ${pair.bLeft.toFixed(2)}, arête droite du voisin à ${pair.aRight.toFixed(2)}`,
  );

  // Alignement sur le nu : l'arête lointaine du voisin accroche aussi, ce qui
  // permet d'aligner deux meubles sur une même ligne.
  const alignTarget = await page.evaluate(() => {
    const v = window.planViewer.view;
    const perMm = 1 / (25.4 / 72) / v.layer.scale.ratio;
    const [a, b] = v.layer.furniture;
    const aTop = a.cy + (a.widthMm * perMm) / 2;
    // On écarte le second meuble puis on le ramène près du nu supérieur du
    // premier, sans le toucher : seul l'alignement doit jouer.
    Object.assign(b, { cx: 600, cy: 200 });
    v.select({ type: 'furniture', id: b.id });
    v.refresh();
    return {
      grab: v.vp.toScreen(b.cx, b.cy),
      drop: v.vp.toScreen(b.cx, aTop - (b.widthMm * perMm) / 2 + 4),
      aTop,
    };
  });
  const grabAlign = at(alignTarget.grab);
  const dropAlign = at(alignTarget.drop);
  await page.mouse.move(grabAlign.x, grabAlign.y);
  await page.mouse.down();
  await page.mouse.move(grabAlign.x, (grabAlign.y + dropAlign.y) / 2, { steps: 8 });
  await page.mouse.move(dropAlign.x, dropAlign.y, { steps: 8 });
  await page.mouse.up();
  const aligned = await page.evaluate(() => {
    const v = window.planViewer.view;
    const perMm = 1 / (25.4 / 72) / v.layer.scale.ratio;
    const [a, b] = v.layer.furniture;
    return { aTop: a.cy + (a.widthMm * perMm) / 2, bTop: b.cy + (b.widthMm * perMm) / 2 };
  });
  check(
    'Deux meubles alignés sur un même nu',
    Math.abs(aligned.bTop - aligned.aTop) < 0.01,
    `nu à ${aligned.bTop.toFixed(2)} contre ${aligned.aTop.toFixed(2)}`,
  );

  // On retire le second meuble : la suite compte sur un seul.
  await page.evaluate(() => {
    const v = window.planViewer.view;
    v.select(null);
    v.layer.furniture.length = 1;
    v.refresh();
  });

  // ── Cote accrochée sur un meuble ──────────────────────────────────────
  const furnitureEdge = await page.evaluate(() => {
    const v = window.planViewer.view;
    const f = v.layer.furniture[0];
    const perMm = 1 / (25.4 / 72) / v.layer.scale.ratio;
    const right = f.cx + (f.lengthMm * perMm) / 2;
    v.select(null);
    // Cote horizontale traversant le meuble, tracée du mur gauche vers son
    // arête droite : l'extrémité doit se poser sur le meuble, pas sur un mur.
    return { right, y: f.cy, start: v.vp.toScreen(110, f.cy), end: v.vp.toScreen(right + 6, f.cy) };
  });
  await page.click('#tool-measure');
  const mStart = at(furnitureEdge.start);
  const mEnd = at(furnitureEdge.end);
  await page.mouse.move(mStart.x, mStart.y);
  await page.mouse.down();
  await page.mouse.move((mStart.x + mEnd.x) / 2, mStart.y, { steps: 8 });
  await page.mouse.move(mEnd.x, mEnd.y, { steps: 8 });
  await page.mouse.up();
  const onFurniture = await page.evaluate(() => {
    const list = window.planViewer.view.layer.measures;
    return list[list.length - 1];
  });
  check(
    'Cote accrochée sur l’arête d’un meuble',
    Math.abs(onFurniture.b.x - furnitureEdge.right) < 0.01,
    `x = ${onFurniture.b.x.toFixed(2)} (arête à ${furnitureEdge.right.toFixed(2)})`,
  );
  await page.click('#tool-pan');
  await page.evaluate(() => {
    const v = window.planViewer.view;
    v.layer.measures.pop(); // on rend l'état attendu par la suite
    v.select(null);
    v.refresh();
  });

  // ── Grille : origine visible, déplaçable, accrochée aux angles ────────
  await page.click('#chk-grid');
  check(
    'Grille : pastille de pas affichée',
    !(await page.locator('#btn-grid-step').isHidden()) &&
      (await page.textContent('#btn-grid-step')) === '1 m',
    await page.textContent('#btn-grid-step'),
  );
  await page.click('#btn-grid-step');
  check(
    'Grille : bascule 1 m → 50 cm',
    (await page.evaluate(() => window.planViewer.view.gridState.stepMm)) === 500 &&
      (await page.textContent('#btn-grid-step')) === '50 cm',
    await page.textContent('#btn-grid-step'),
  );
  await page.click('#btn-grid-step');

  // L'origine part du coin de la page tant qu'on ne l'a pas déplacée.
  const gridStart = await page.evaluate(() => {
    const v = window.planViewer.view;
    v.select(null);
    const o = v.gridOrigin();
    return { pdf: o, screen: v.vp.toScreen(o.x, o.y), pageCorner: v.page.view.slice(0, 2) };
  });
  check(
    'Grille : origine au coin de la page par défaut',
    Math.abs(gridStart.pdf.x - gridStart.pageCorner[0]) < 0.01 &&
      Math.abs(gridStart.pdf.y - gridStart.pageCorner[1]) < 0.01,
  );

  // On la tire vers l'angle intérieur des murs (100, 100), en visant à côté :
  // l'accrochage doit terminer le travail.
  const cornerTarget = await page.evaluate(() => window.planViewer.view.vp.toScreen(112, 113));
  const gFrom = at(gridStart.screen);
  const gTo = at(cornerTarget);
  await page.mouse.move(gFrom.x, gFrom.y);
  await page.mouse.down();
  await page.mouse.move((gFrom.x + gTo.x) / 2, (gFrom.y + gTo.y) / 2, { steps: 10 });
  await page.mouse.move(gTo.x, gTo.y, { steps: 10 });
  await page.mouse.up();

  const gridMoved = await page.evaluate(() => window.planViewer.view.gridOrigin());
  check(
    'Grille : origine accrochée sur l’angle des murs',
    Math.abs(gridMoved.x - 100) < 0.01 && Math.abs(gridMoved.y - 100) < 0.01,
    `origine en (${gridMoved.x.toFixed(2)}, ${gridMoved.y.toFixed(2)}) — angle en (100, 100)`,
  );

  // Le pas se compte désormais depuis cette origine.
  const snapped = await page.evaluate(() => {
    const v = window.planViewer.view;
    const perMm = 1 / (25.4 / 72) / v.layer.scale.ratio;
    const step = 1000 * perMm; // 1 m
    // Un point à 1 m + 3 pt de l'origine doit retomber pile sur 1 m.
    return { step, snapped: v.snapGridForTest({ x: 100 + step + 3, y: 100 + step + 3 }) };
  });
  check(
    'Grille : accrochage compté depuis l’origine',
    Math.abs(snapped.snapped.x - (100 + snapped.step)) < 0.01 &&
      Math.abs(snapped.snapped.y - (100 + snapped.step)) < 0.01,
  );

  // ── Un meuble suit la grille déplacée ─────────────────────────────────
  // L'accrochage portait sur le CENTRE du meuble : un meuble de 90 cm centré
  // sur un nœud a ses bords à 45 cm des lignes, et l'accrochage semblait sans
  // rapport avec le quadrillage. Ce sont les arêtes qui doivent s'aligner —
  // et sur l'origine courante, pas sur celle du coin de la page.
  await page.click('#chk-snap'); // murs écartés : on isole la grille
  const gridDrag = await page.evaluate(() => {
    const v = window.planViewer.view;
    const f = v.layer.furniture[0];
    Object.assign(f, { rot: 0, lengthMm: 2000, widthMm: 900, cx: 300, cy: 420 });
    v.select({ type: 'furniture', id: f.id });
    v.refresh();
    return v.vp.toScreen(f.cx, f.cy);
  });
  const gDragFrom = at(gridDrag);
  await page.mouse.move(gDragFrom.x, gDragFrom.y);
  await page.mouse.down();
  await page.mouse.move(gDragFrom.x + 25, gDragFrom.y - 17, { steps: 10 });
  await page.mouse.move(gDragFrom.x + 47, gDragFrom.y - 31, { steps: 10 });
  await page.mouse.up();
  const onGrid = await page.evaluate(() => {
    const v = window.planViewer.view;
    const f = v.layer.furniture[0];
    const perMm = 1 / (25.4 / 72) / v.layer.scale.ratio;
    const step = 1000 * perMm;
    const half = { x: (f.lengthMm * perMm) / 2, y: (f.widthMm * perMm) / 2 };
    const edges = {
      x: [f.cx - half.x, f.cx + half.x],
      y: [f.cy - half.y, f.cy + half.y],
    };
    const on = (value, origin) =>
      Math.abs(value - (origin + Math.round((value - origin) / step) * step)) < 0.01;
    return {
      edges,
      movedX: edges.x.some((e) => on(e, 100)),
      movedY: edges.y.some((e) => on(e, 100)),
      defaultX: edges.x.some((e) => on(e, 0)),
      defaultY: edges.y.some((e) => on(e, 0)),
    };
  });
  check(
    'Grille : les arêtes du meuble se posent sur le quadrillage',
    onGrid.movedX && onGrid.movedY,
    `x = ${onGrid.edges.x.map((e) => e.toFixed(2)).join(' / ')}, y = ${onGrid.edges.y
      .map((e) => e.toFixed(2))
      .join(' / ')}`,
  );
  check(
    'Grille : le meuble suit l’origine déplacée, pas celle du coin de page',
    !onGrid.defaultX && !onGrid.defaultY,
  );
  await page.click('#chk-snap');

  await page.click('#chk-grid');
  check('Grille masquée : pastille retirée', await page.locator('#btn-grid-step').isHidden());

  // ── Annulation ────────────────────────────────────────────────────────
  const undoStart = await page.evaluate(() => ({
    furniture: window.planViewer.view.layer.furniture.length,
    label: window.planViewer.view.layer.furniture[0].label,
    disabled: document.getElementById('btn-undo').disabled,
  }));
  check('Bouton Annuler actif après des modifications', undoStart.disabled === false);

  // Une suppression s'annule.
  await page.evaluate(() => {
    const v = window.planViewer.view;
    v.select({ type: 'furniture', id: v.layer.furniture[0].id });
    v.deleteSelected();
  });
  check(
    'Suppression effectuée',
    (await page.evaluate(() => window.planViewer.view.layer.furniture.length)) === undoStart.furniture - 1,
  );
  await menuClick(page, '#btn-undo');
  check(
    'Annuler restaure le meuble supprimé',
    (await page.evaluate(() => window.planViewer.view.layer.furniture.length)) === undoStart.furniture &&
      (await page.evaluate(() => window.planViewer.view.layer.furniture[0].label)) === undoStart.label,
  );

  // Une rotation s'annule aussi.
  await page.evaluate(() => {
    const v = window.planViewer.view;
    v.select({ type: 'furniture', id: v.layer.furniture[0].id });
    v.rotateSelected(90);
  });
  const rotated = await page.evaluate(() => window.planViewer.view.layer.furniture[0].rot);
  await menuClick(page, '#btn-undo');
  check(
    'Annuler défait la rotation',
    rotated === 90 && (await page.evaluate(() => window.planViewer.view.layer.furniture[0].rot)) === 0,
  );

  // La saisie d'un nom ne forme qu'un seul point d'annulation.
  const beforeTyping = await page.evaluate(() => window.planViewer.view.layer.furniture[0].label);
  await page.evaluate(() => {
    const v = window.planViewer.view;
    const id = v.layer.furniture[0].id;
    v.select({ type: 'furniture', id });
    for (const text of ['C', 'Ch', 'Cha', 'Chai', 'Chais', 'Chaise']) {
      v.updateSelected({ label: text }, `label:${id}`);
    }
  });
  await menuClick(page, '#btn-undo');
  check(
    'Annuler défait toute la saisie d’un nom, pas une lettre',
    (await page.evaluate(() => window.planViewer.view.layer.furniture[0].label)) === beforeTyping,
    `« ${await page.evaluate(() => window.planViewer.view.layer.furniture[0].label)} »`,
  );

  // La vue ne doit pas reculer avec l'annulation.
  const zoomBefore = await page.evaluate(() => window.planViewer.view.vp.scale);
  await page.evaluate(() => {
    const v = window.planViewer.view;
    v.select({ type: 'furniture', id: v.layer.furniture[0].id });
    v.rotateSelected(90);
  });
  await menuClick(page, '#btn-undo');
  check(
    'Annuler ne déplace pas la vue',
    Math.abs((await page.evaluate(() => window.planViewer.view.vp.scale)) - zoomBefore) < 1e-9,
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

  // ── iPhone : barre d'outils sur une seule rangée + menu burger ────────
  // La barre tenait sur deux rangées et mangeait l'écran : les commandes
  // secondaires vivent désormais dans le menu.
  const bar = await phonePage.evaluate(() => {
    const toolbar = document.getElementById('toolbar');
    const tops = [...toolbar.querySelectorAll('.btn')].map((b) => Math.round(b.getBoundingClientRect().top));
    return { rows: new Set(tops).size, height: Math.round(toolbar.getBoundingClientRect().height) };
  });
  check(
    'iPhone : barre d’outils sur une seule rangée',
    bar.rows === 1,
    `${bar.rows} rangée(s), ${bar.height} px`,
  );

  await phonePage.click('#btn-menu');
  await phonePage.waitForFunction(() => document.getElementById('dlg-menu').open, null, { timeout: 5_000 });
  const menuEntries = await phonePage.evaluate(() =>
    ['btn-open', 'btn-drive', 'btn-undo', 'btn-fit', 'btn-scale', 'btn-export', 'menu-page', 'menu-clear']
      .filter((id) => {
        const el = document.getElementById(id);
        return el && el.closest('#dlg-menu') && el.getBoundingClientRect().height > 0;
      }),
  );
  check(
    'iPhone : les commandes secondaires sont dans le menu',
    menuEntries.length === 8,
    menuEntries.join(', '),
  );

  await phonePage.click('#btn-fit');
  check(
    'iPhone : une commande du menu s’exécute et referme le menu',
    !(await phonePage.evaluate(() => document.getElementById('dlg-menu').open)),
  );

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
