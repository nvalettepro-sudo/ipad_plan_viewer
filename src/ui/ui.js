/** Petits utilitaires d'interface : sélecteurs, toasts, confirmations. */

export const $ = (id) => document.getElementById(id);

/** Message éphémère en haut de l'écran. */
export function toast(message, { error = false, duration = 3200 } = {}) {
  const stack = $('toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

/** Ouvre un `<dialog>` et résout avec la valeur du bouton pressé. */
export function openDialog(dialog) {
  // `showModal()` lève une exception sur un dialogue déjà ouvert : on referme
  // d'abord, sinon un enchaînement inattendu casse toute l'interface.
  if (dialog.open) dialog.close();
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue);
    };
    dialog.addEventListener('close', onClose);
    dialog.returnValue = '';
    dialog.showModal();
  });
}

/** Confirmation modale réutilisable. */
export async function confirmAction(title, text) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  return (await openDialog($('dlg-confirm'))) === 'ok';
}

/** Formate une taille en octets pour l'affichage. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['o', 'ko', 'Mo', 'Go'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

/** Date courte relative, pour la liste des plans. */
export function formatDate(timestamp) {
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(timestamp),
  );
}
