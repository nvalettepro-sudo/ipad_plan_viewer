/**
 * Panneau d'édition de l'objet sélectionné.
 *
 * Reconstruit à chaque changement de sélection : le volume est faible et ça
 * évite tout état résiduel entre un meuble et une cote.
 */

import { dist } from '../core/geometry.js';
import { formatLength, fromMm, mmPerPt, toMm } from '../core/units.js';
import { FURNITURE_COLORS } from '../viewer/overlay.js';

function row(labelText, node) {
  const el = document.createElement('div');
  el.className = 'row';
  const label = document.createElement('label');
  label.textContent = labelText;
  el.append(label, node);
  return el;
}

function numberInput(value, onCommit) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.step = '1';
  input.inputMode = 'decimal';
  input.value = Number.isFinite(value) ? String(Math.round(value * 10) / 10) : '';
  const commit = () => {
    const next = Number(input.value);
    if (Number.isFinite(next) && next > 0) onCommit(next);
  };
  input.addEventListener('change', commit);
  return input;
}

function button(text, onClick, className = 'btn') {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.textContent = text;
  el.addEventListener('click', onClick);
  return el;
}

/**
 * @param {PlanViewLike} view
 * @param {{title: HTMLElement, body: HTMLElement, root: HTMLElement}} dom
 * @param {() => void} onChange
 */
export function renderInspector(view, dom, onChange) {
  const selection = view.selection;
  const object = view.getSelected();
  dom.body.replaceChildren();

  if (!selection || !object) {
    dom.root.hidden = true;
    return;
  }
  dom.root.hidden = false;

  if (selection.type === 'furniture') {
    dom.title.textContent = object.label || 'Meuble';

    const name = document.createElement('input');
    name.type = 'text';
    name.value = object.label || '';
    name.placeholder = 'Nom';
    name.maxLength = 40;
    name.addEventListener('input', () => {
      view.updateSelected({ label: name.value });
      dom.title.textContent = name.value || 'Meuble';
      onChange();
    });
    dom.body.append(row('Nom', name));

    const unit = view.unit === 'auto' ? 'cm' : view.unit;
    const unitLabel = `Long. (${unit})`;
    dom.body.append(
      row(
        unitLabel,
        numberInput(fromMm(object.lengthMm, unit), (v) => {
          view.updateSelected({ lengthMm: toMm(v, unit) });
          onChange();
        }),
      ),
    );
    dom.body.append(
      row(
        `Larg. (${unit})`,
        numberInput(fromMm(object.widthMm, unit), (v) => {
          view.updateSelected({ widthMm: toMm(v, unit) });
          onChange();
        }),
      ),
    );

    const swatches = document.createElement('div');
    swatches.className = 'swatches';
    for (const color of FURNITURE_COLORS) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'swatch';
      swatch.style.background = color;
      swatch.setAttribute('aria-pressed', String(color === object.color));
      swatch.addEventListener('click', () => {
        view.updateSelected({ color });
        // Mise à jour sur place plutôt que reconstruction : reconstruire
        // arracherait le champ « Nom » et refermerait le clavier.
        for (const other of swatches.children) other.setAttribute('aria-pressed', 'false');
        swatch.setAttribute('aria-pressed', 'true');
        onChange();
      });
      swatches.append(swatch);
    }
    dom.body.append(row('Couleur', swatches));

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      button('↻ 90°', () => {
        view.rotateSelected(90);
        onChange();
      }),
      button('Dupliquer', () => {
        view.addFurniture({
          label: object.label,
          lengthMm: object.lengthMm,
          widthMm: object.widthMm,
          color: object.color,
        });
        onChange();
      }),
      button('Supprimer', () => {
        view.deleteSelected();
        onChange();
      }, 'btn danger'),
    );
    dom.body.append(actions);
    return;
  }

  // ── Cote ────────────────────────────────────────────────────────────────
  dom.title.textContent = 'Cote';
  const lengthMm = dist(object.a, object.b) * mmPerPt(view.scale);
  const unit = view.unit === 'auto' ? (lengthMm >= 1000 ? 'm' : 'cm') : view.unit;

  const info = document.createElement('div');
  info.textContent = `${object.axis === 'h' ? 'Horizontale' : 'Verticale'} · ${formatLength(lengthMm, view.unit)}`;
  dom.body.append(info);

  dom.body.append(
    row(
      `Longueur (${unit})`,
      numberInput(fromMm(lengthMm, unit), (v) => {
        setMeasureLength(view, object, toMm(v, unit));
        onChange();
      }),
    ),
  );

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    button('Supprimer', () => {
      view.deleteSelected();
      onChange();
    }, 'btn danger'),
  );
  dom.body.append(actions);
}

/** Impose une longueur réelle à une cote en déplaçant son extrémité B. */
function setMeasureLength(view, measure, targetMm) {
  const perMm = 1 / mmPerPt(view.scale);
  const lengthPt = targetMm * perMm;
  const axis = measure.axis || 'h';
  const sign = axis === 'h' ? Math.sign(measure.b.x - measure.a.x) || 1 : Math.sign(measure.b.y - measure.a.y) || 1;
  measure.b =
    axis === 'h'
      ? { x: measure.a.x + sign * lengthPt, y: measure.a.y }
      : { x: measure.a.x, y: measure.a.y + sign * lengthPt };
  view.refresh();
}
