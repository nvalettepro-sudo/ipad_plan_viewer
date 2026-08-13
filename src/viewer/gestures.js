/**
 * Gestion des gestes tactiles sur la zone de rendu.
 *
 * Règles (contrainte iPad n°3) :
 *  - 1 doigt  → action de l'outil courant (tracer une cote, déplacer un meuble…)
 *  - 2 doigts → toujours déplacement + zoom du plan, quel que soit l'outil
 *  - double-tap → zoom avant, ou retour à l'ajustement écran si déjà zoomé
 *
 * Tous les gestes sont capturés (`touch-action: none` côté CSS + `preventDefault`),
 * sinon Safari fait défiler la page et déclenche son propre zoom.
 */

const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 32;
const DRAG_THRESHOLD_PX = 4;

export class GestureController {
  /**
   * @param {HTMLElement} element
   * @param {{
   *   onDragStart?: (p: {x:number,y:number}) => void,
   *   onDragMove?: (p: {x:number,y:number}) => void,
   *   onDragEnd?: (p: {x:number,y:number}, moved: boolean) => void,
   *   onDragCancel?: () => void,
   *   onTransform?: (t: {dx:number, dy:number, scale:number, cx:number, cy:number}) => void,
   *   onTransformEnd?: () => void,
   *   onDoubleTap?: (p: {x:number,y:number}) => void,
   * }} handlers
   */
  constructor(element, handlers) {
    this.el = element;
    this.h = handlers;
    /** @type {Map<number, {x:number,y:number}>} */
    this.pointers = new Map();
    this.mode = 'idle'; // idle | drag | pinch
    this.start = null;
    this.moved = false;
    this.lastTap = null;
    this.pinch = null;

    this.el.addEventListener('pointerdown', this.#onDown, { passive: false });
    this.el.addEventListener('pointermove', this.#onMove, { passive: false });
    this.el.addEventListener('pointerup', this.#onUp, { passive: false });
    this.el.addEventListener('pointercancel', this.#onUp, { passive: false });
    this.el.addEventListener('wheel', this.#onWheel, { passive: false });
    // Safari iPad peut encore émettre ses gestes de zoom natifs si l'utilisateur
    // a activé « Toujours autoriser le zoom » dans les réglages d'accessibilité.
    this.el.addEventListener('gesturestart', preventDefault, { passive: false });
    this.el.addEventListener('gesturechange', preventDefault, { passive: false });
    this.el.addEventListener('gestureend', preventDefault, { passive: false });
    this.el.addEventListener('contextmenu', preventDefault);
  }

  destroy() {
    this.el.removeEventListener('pointerdown', this.#onDown);
    this.el.removeEventListener('pointermove', this.#onMove);
    this.el.removeEventListener('pointerup', this.#onUp);
    this.el.removeEventListener('pointercancel', this.#onUp);
    this.el.removeEventListener('wheel', this.#onWheel);
    this.el.removeEventListener('gesturestart', preventDefault);
    this.el.removeEventListener('gesturechange', preventDefault);
    this.el.removeEventListener('gestureend', preventDefault);
    this.el.removeEventListener('contextmenu', preventDefault);
  }

  #local(event) {
    const rect = this.el.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  #onDown = (event) => {
    event.preventDefault();
    this.el.setPointerCapture?.(event.pointerId);
    const p = this.#local(event);
    this.pointers.set(event.pointerId, p);

    if (this.pointers.size === 1) {
      this.mode = 'drag';
      this.start = p;
      this.moved = false;
      this.h.onDragStart?.(p);
    } else if (this.pointers.size === 2) {
      // Le second doigt annule l'action à un doigt en cours.
      if (this.mode === 'drag') this.h.onDragCancel?.();
      this.mode = 'pinch';
      this.pinch = this.#pinchState();
    }
  };

  #onMove = (event) => {
    if (!this.pointers.has(event.pointerId)) return;
    event.preventDefault();
    const p = this.#local(event);
    this.pointers.set(event.pointerId, p);

    if (this.mode === 'drag' && this.pointers.size === 1) {
      if (!this.moved && Math.hypot(p.x - this.start.x, p.y - this.start.y) > DRAG_THRESHOLD_PX) {
        this.moved = true;
      }
      this.h.onDragMove?.(p);
      return;
    }

    if (this.mode === 'pinch' && this.pointers.size >= 2) {
      const next = this.#pinchState();
      if (this.pinch && next.dist > 0 && this.pinch.dist > 0) {
        this.h.onTransform?.({
          dx: next.cx - this.pinch.cx,
          dy: next.cy - this.pinch.cy,
          scale: next.dist / this.pinch.dist,
          cx: next.cx,
          cy: next.cy,
        });
      }
      this.pinch = next;
    }
  };

  #onUp = (event) => {
    if (!this.pointers.has(event.pointerId)) return;
    event.preventDefault();
    const p = this.pointers.get(event.pointerId);
    this.pointers.delete(event.pointerId);
    this.el.releasePointerCapture?.(event.pointerId);

    if (this.mode === 'drag' && this.pointers.size === 0) {
      if (event.type === 'pointercancel') {
        this.h.onDragCancel?.();
      } else {
        this.h.onDragEnd?.(p, this.moved);
        if (!this.moved) this.#registerTap(p);
      }
      this.mode = 'idle';
      return;
    }

    if (this.mode === 'pinch') {
      if (this.pointers.size >= 2) {
        this.pinch = this.#pinchState();
      } else {
        this.h.onTransformEnd?.();
        this.pinch = null;
        // Le doigt restant ne redevient pas un geste d'outil : on attend
        // que tous les doigts soient levés, sinon un pincement se terminerait
        // par un tracé involontaire.
        this.mode = this.pointers.size === 0 ? 'idle' : 'settling';
      }
      return;
    }

    if (this.pointers.size === 0) this.mode = 'idle';
  };

  #registerTap(p) {
    const now = performance.now();
    if (
      this.lastTap &&
      now - this.lastTap.t < DOUBLE_TAP_MS &&
      Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < DOUBLE_TAP_PX
    ) {
      this.lastTap = null;
      this.h.onDoubleTap?.(p);
    } else {
      this.lastTap = { ...p, t: now };
    }
  }

  #pinchState() {
    const [a, b] = [...this.pointers.values()];
    return {
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      dist: Math.hypot(b.x - a.x, b.y - a.y),
    };
  }

  /** Molette / trackpad — confort sur ordinateur pendant le développement. */
  #onWheel = (event) => {
    event.preventDefault();
    const rect = this.el.getBoundingClientRect();
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;
    if (event.ctrlKey || event.metaKey) {
      this.h.onTransform?.({ dx: 0, dy: 0, scale: Math.exp(-event.deltaY / 180), cx, cy });
    } else {
      this.h.onTransform?.({ dx: -event.deltaX, dy: -event.deltaY, scale: 1, cx, cy });
    }
    this.h.onTransformEnd?.();
  };
}

function preventDefault(event) {
  event.preventDefault();
}
