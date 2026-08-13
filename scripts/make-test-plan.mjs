/**
 * Fabrique un PDF de test vectoriel (petit plan coté, échelle 1/50) utilisé par
 * le test de fumée. Exporté comme fonction pour éviter un fichier binaire dans
 * le dépôt.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/** A4 paysage, murs à angles droits — de quoi valider extraction et accrochage. */
export async function makeTestPlan() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([842, 595]); // A4 paysage en points
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const black = rgb(0, 0, 0);

  const wall = (x1, y1, x2, y2) =>
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 3, color: black });

  // Enveloppe : 600 × 400 pt → 10,58 m × 7,06 m à l'échelle 1/50
  wall(100, 100, 700, 100);
  wall(700, 100, 700, 500);
  wall(700, 500, 100, 500);
  wall(100, 500, 100, 100);

  // Refends intérieurs
  wall(400, 100, 400, 350);
  wall(400, 350, 700, 350);

  page.drawRectangle({
    x: 150,
    y: 150,
    width: 120,
    height: 80,
    borderColor: black,
    borderWidth: 1.5,
  });

  page.drawText('PLAN DE TEST — 1/50', { x: 100, y: 530, size: 14, font, color: black });

  // Seconde page : sert à vérifier que les annotations et l'échelle sont bien
  // propres à chaque page (cas du carnet de détails multi-échelles).
  const detail = doc.addPage([842, 595]);
  detail.drawLine({ start: { x: 200, y: 200 }, end: { x: 500, y: 200 }, thickness: 3, color: black });
  detail.drawLine({ start: { x: 200, y: 200 }, end: { x: 200, y: 400 }, thickness: 3, color: black });
  detail.drawText('DÉTAIL — autre échelle', { x: 200, y: 450, size: 14, font, color: black });

  return doc.save();
}
