/**
 * Import de PDF depuis Google Drive : Google Identity Services + Picker API.
 *
 * Deux points sont critiques et dictent la forme de ce module :
 *
 * 1. Contrainte iPad n°2 — Safari bloque la popup OAuth si `requestAccessToken()`
 *    n'est pas appelé *strictement* dans le gestionnaire de tap. `requestFile()`
 *    est donc synchrone jusqu'à cet appel : aucun `await` avant lui. Les scripts
 *    Google sont préchargés au démarrage pour qu'ils soient déjà là au moment du tap.
 *
 * 2. Scope `drive.file` (et non `drive.readonly`) : classé « non sensible » par
 *    Google, il évite la procédure de vérification. Associé au Picker, il donne
 *    accès aux fichiers que l'utilisateur sélectionne explicitement.
 *
 * On n'utilise volontairement aucun accès hors-ligne (pas de refresh token) :
 * en mode « Test », ces jetons expirent au bout de 7 jours. Un jeton d'accès
 * demandé à la volée n'est pas concerné.
 */

import { getSetting, setSetting } from '../core/idb.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GSI_SRC = 'https://accounts.google.com/gsi/client';
const GAPI_SRC = 'https://apis.google.com/js/api.js';
const SETTINGS_KEY = 'google-config';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') resolve();
      else {
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error(`Chargement impossible : ${src}`)));
      }
      return;
    }
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.addEventListener('load', () => {
      el.dataset.loaded = '1';
      resolve();
    });
    el.addEventListener('error', () => reject(new Error(`Chargement impossible : ${src}`)));
    document.head.appendChild(el);
  });
}

/** Config par défaut : variables d'environnement injectées au build. */
function envConfig() {
  return {
    clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID || '',
    apiKey: import.meta.env.VITE_GOOGLE_API_KEY || '',
    appId: import.meta.env.VITE_GOOGLE_APP_ID || '',
  };
}

export class DriveClient {
  constructor() {
    this.config = envConfig();
    this.ready = false;
    this.loading = null;
    this.tokenClient = null;
    this.token = null;
    this.tokenExpiry = 0;
  }

  get isConfigured() {
    return Boolean(this.config.clientId && this.config.apiKey);
  }

  /** Configuration effective (env, écrasée par ce qui est stocké sur l'appareil). */
  async loadConfig() {
    const stored = await getSetting(SETTINGS_KEY, null);
    this.config = { ...envConfig(), ...(stored || {}) };
    return this.config;
  }

  async saveConfig(config) {
    this.config = { ...this.config, ...config };
    await setSetting(SETTINGS_KEY, this.config);
    // Le client de jeton dépend du client_id : on le reconstruira.
    this.tokenClient = null;
    this.token = null;
    this.ready = false;
    await this.preload();
  }

  /**
   * Précharge les scripts Google et instancie le client de jeton.
   * À appeler au démarrage : au moment du tap « Importer », tout doit être prêt.
   */
  async preload() {
    if (this.ready) return true;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      await this.loadConfig();
      if (!this.isConfigured) return false;
      await Promise.all([loadScript(GSI_SRC), loadScript(GAPI_SRC)]);
      await new Promise((resolve, reject) => {
        window.gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('Picker indisponible')) });
      });
      this.tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: this.config.clientId,
        scope: SCOPE,
        callback: () => {}, // remplacé à chaque demande
      });
      this.ready = true;
      return true;
    })();

    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  get hasValidToken() {
    return Boolean(this.token) && Date.now() < this.tokenExpiry - 60_000;
  }

  /**
   * Ouvre le sélecteur Drive et renvoie le PDF choisi.
   *
   * ⚠️ Doit être appelée **directement** depuis un gestionnaire de clic, sans
   * `await` en amont, sinon iOS bloque la popup d'authentification.
   *
   * @returns {Promise<{name:string, bytes:ArrayBuffer, fileId:string}|null>}
   */
  requestFile() {
    if (!this.ready) {
      return Promise.reject(
        new Error(
          this.isConfigured
            ? 'Connexion Google en cours d’initialisation, réessayez dans un instant.'
            : 'Google Drive n’est pas configuré (menu ⋯ → Configuration Google Drive).',
        ),
      );
    }

    if (this.hasValidToken) return this.#pickAndDownload();

    // Appel synchrone : c'est ce qui autorise la popup sur iOS.
    const auth = new Promise((resolve, reject) => {
      this.tokenClient.callback = (response) => {
        if (response?.error) {
          reject(new Error(`Authentification refusée (${response.error})`));
          return;
        }
        this.token = response.access_token;
        this.tokenExpiry = Date.now() + (Number(response.expires_in) || 3600) * 1000;
        resolve();
      };
      this.tokenClient.error_callback = (err) => {
        reject(
          new Error(
            err?.type === 'popup_closed'
              ? 'Fenêtre de connexion fermée.'
              : 'Fenêtre de connexion bloquée par le navigateur.',
          ),
        );
      };
      this.tokenClient.requestAccessToken({ prompt: '' });
    });

    return auth.then(() => this.#pickAndDownload());
  }

  async #pickAndDownload() {
    const file = await this.#openPicker();
    if (!file) return null;
    const bytes = await this.#download(file.id);
    return { name: file.name || 'plan.pdf', bytes, fileId: file.id };
  }

  #openPicker() {
    const { google } = window;
    return new Promise((resolve, reject) => {
      const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setMimeTypes('application/pdf')
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false);

      const builder = new google.picker.PickerBuilder()
        .setOAuthToken(this.token)
        .setDeveloperKey(this.config.apiKey)
        .addView(view)
        .setTitle('Choisir un plan PDF')
        .setCallback((data) => {
          const action = data[google.picker.Response.ACTION];
          if (action === google.picker.Action.PICKED) {
            resolve(data[google.picker.Response.DOCUMENTS]?.[0] || null);
          } else if (action === google.picker.Action.CANCEL) {
            resolve(null);
          }
        });

      // L'App ID (numéro de projet) est requis pour que `drive.file` accorde
      // l'accès aux fichiers sélectionnés dans le Picker.
      if (this.config.appId) builder.setAppId(this.config.appId);

      try {
        builder.build().setVisible(true);
      } catch (err) {
        reject(err);
      }
    });
  }

  async #download(fileId) {
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Téléchargement Drive impossible (${response.status}). ${detail.slice(0, 200)}`);
    }
    return response.arrayBuffer();
  }
}
