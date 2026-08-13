# Plans d'architecture — viewer PDF pour iPad

PWA mono-utilisateur pour **visualiser, mesurer et annoter des plans d'architecture
PDF** sur iPad, à échelle connue (1/50, 1/100, …), avec import depuis Google Drive
et export du plan annoté sans perte.

Installée sur l'écran d'accueil, elle fonctionne hors ligne et conserve le travail
entre les sessions.

| Fonction | État |
| --- | --- |
| Navigation : pincer / pan 2 doigts / double-tap / ajustement écran / mini-carte | ✅ |
| Mesures contraintes H ou V, avec accrochage sur les tracés du PDF | ✅ |
| Mesure manuelle + grille magnétique (repli pour les PDF scannés) | ✅ |
| Mobilier : rectangles cotés en dimensions réelles, rotation 90°, couleur, étiquette | ✅ |
| Sauvegarde locale automatique (IndexedDB + stockage persistant) | ✅ |
| Export PDF annoté (superposition sur le PDF d'origine, échelle native conservée) | ✅ |
| Import Google Drive (Picker + `drive.file`) | ✅ |
| Sauvegarde de secours vers Drive (JSON de calques) | ⏳ v2 |

---

## Stack

| Rôle | Choix | Pourquoi |
| --- | --- | --- |
| Rendu PDF | [PDF.js](https://mozilla.github.io/pdf.js/) | Rendu **et** accès aux tracés vectoriels, nécessaire à l'accrochage |
| Export annoté | [pdf-lib](https://pdf-lib.js.org/) | Écrit les annotations dans l'espace utilisateur du PDF d'origine : aucune rastérisation, échelle conservée |
| Stockage | IndexedDB + `navigator.storage.persist()` | Survit à la fermeture de l'app ; `persist()` évite la purge Safari |
| Import Drive | Google Identity Services + Picker API | `gapi.auth2` est déprécié et n'est pas utilisé |
| Build | Vite | Empaquette le worker PDF.js, hashe les assets, génère le service worker |

Aucun framework d'interface : du DOM et un `<canvas>`, c'est suffisant et ça évite
une couche d'abstraction entre les gestes tactiles et le rendu.

### Version de PDF.js volontairement figée

`pdfjs-dist` est **épinglé à `5.4.624`** (sans `^`). Les versions ≥ 5.5 utilisent
`Map.prototype.getOrInsertComputed`, une API JS trop récente pour la plupart des
Safari/Chrome installés : l'app plante à l'ouverture d'un PDF. Ne relevez cette
version qu'après avoir vérifié la compatibilité sur l'iPad cible.

---

## Structure

```
index.html               interface complète (DOM statique, dialogues inclus)
public/
  manifest.webmanifest   manifeste PWA (chemins relatifs → compatible sous-dossier)
  icons/                 icônes 192/512/maskable/apple-touch (générées, versionnées)
src/
  main.js                câblage de l'interface, import, dialogues, export
  styles.css
  core/       units.js (échelles), geometry.js, idb.js, store.js (plans + calques)
  pdf/        loader.js (init PDF.js), vector.js (extraction des tracés + index d'accrochage)
  viewer/     planview.js (composant central), viewport.js, renderer.js,
              gestures.js, overlay.js
  drive/      google.js (OAuth + Picker + téléchargement)
  export/     exportPdf.js (superposition pdf-lib)
  pwa/        updates.js (service worker + bandeau de mise à jour)
  ui/         ui.js, inspector.js
scripts/      sw-template.js, generate-icons.mjs, smoke-test.mjs, make-test-plan.mjs
```

---

## Lancer en local

```bash
npm install
npm run dev          # http://localhost:5173
```

Sans configuration Google, tout fonctionne sauf l'import Drive : utilisez le bouton
**Ouvrir** pour charger un PDF depuis le disque.

> En développement, le service worker n'est **pas** enregistré (c'est volontaire :
> il masquerait les modifications). Pour tester le comportement PWA réel :
>
> ```bash
> npm run build && npm run preview -- --host
> ```

### Tests

```bash
npm run build && npm run test:smoke
```

Le test de fumée fabrique un PDF vectoriel, l'importe dans un vrai Chromium et
vérifie le parcours complet : extraction des tracés, conversion d'échelle,
création d'une cote au geste, ajout d'un meuble, persistance après rechargement,
export relisible, enregistrement du service worker.

**Il ne remplace pas les tests sur l'iPad réel.** Les gestes à deux doigts, les
conflits avec les gestes système et les limites mémoire ne se reproduisent pas
fidèlement sur ordinateur : testez sur l'iPad dès les premières fonctions de
navigation, pas seulement à la fin.

### Régénérer les icônes

```bash
npm run icons        # rastérise scripts/icon.svg vers public/icons/
```

---

## Déploiement

Une PWA doit être servie en **HTTPS** : un fichier ouvert localement ne permet ni
le service worker, ni l'installation.

### GitHub Pages (aucun compte tiers)

Le workflow [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)
publie à chaque `push` sur `main`.

1. Dépôt → **Settings → Pages → Source : GitHub Actions**.
2. Optionnel, pour préremplir les identifiants Google : **Settings → Secrets and
   variables → Actions**, ajouter `VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_API_KEY`,
   `VITE_GOOGLE_APP_ID`.
3. `git push` → l'URL est `https://<utilisateur>.github.io/<dépôt>/`.

Le workflow positionne `BASE_PATH=/<dépôt>/` : indispensable, sinon les assets et
le service worker renvoient des 404 sous GitHub Pages.

### Netlify / Vercel

Connecter le dépôt suffit ; [`netlify.toml`](netlify.toml) et
[`vercel.json`](vercel.json) fixent déjà la commande de build, le dossier `dist`
et les en-têtes de cache (notamment `sw.js` en `no-cache`, sinon la détection de
mise à jour peut avoir 24 h de retard). Variables d'environnement à renseigner
dans l'interface de l'hébergeur : voir [`.env.example`](.env.example).

---

## Installer sur l'iPad

1. Ouvrir l'URL de l'app dans **Safari** (le seul navigateur iOS dont le
   comportement d'installation est garanti).
2. Icône **Partager** (carré avec flèche vers le haut).
3. Faire défiler → **« Sur l'écran d'accueil »**.
4. Confirmer le nom → **Ajouter**.
5. **Lancer l'app depuis son icône**, jamais depuis Safari : c'est ce mode
   *standalone* qui active la persistance des données.
6. Au premier lancement : accepter le stockage persistant, puis se connecter à
   Google Drive si vous l'utilisez.

Le menu **⋯ → État du stockage** indique à tout moment si le stockage est
persistant et si l'app tourne bien en mode standalone.

### Pourquoi une PWA et pas un simple fichier HTML

- **Purge Safari (ITP)** : les données locales d'un site « navigateur classique »
  sont effacées après 7 jours sans visite. Une PWA installée via « Sur l'écran
  d'accueil » n'est pas concernée. L'app demande `navigator.storage.persist()`
  au premier lancement.
- Sans manifeste ni service worker, pas d'icône correcte, pas de fonctionnement
  hors ligne, et le contenu peut passer sous la barre de statut.

---

## Cycle d'itération et bandeau de mise à jour

Une PWA installée continue de servir la version en cache après un déploiement.
L'app implémente donc une détection explicite (`updatefound` + `skipWaiting`) :

1. Décrire le changement souhaité, modifier le code, tester en local.
2. `git push` → l'hébergeur republie automatiquement.
3. Rouvrir l'app sur l'iPad → le bandeau **« Mise à jour disponible »** apparaît
   (une vérification est déclenchée à chaque retour au premier plan).
4. Appuyer sur **Recharger** : la nouvelle version s'active et la page se
   recharge une seule fois.

Rien n'est rechargé silencieusement : une mise à jour ne peut pas interrompre une
mesure en cours.

---

## Configuration Google Drive

Les identifiants peuvent être saisis **dans l'app** (menu ⋯ → *Configuration
Google Drive…*, stockés sur l'appareil) ou injectés au build via `.env`
(voir [`.env.example`](.env.example)). Le code étant 100 % côté navigateur, ces
valeurs sont de toute façon visibles : la protection repose sur la restriction
par domaine.

Dans la [console Google Cloud](https://console.cloud.google.com/) :

1. Créer un projet, activer **Google Drive API** et **Google Picker API**.
2. Écran de consentement OAuth : type **Externe**, statut **Test**, et
   s'ajouter comme **utilisateur de test**.
   → évite complètement la procédure de vérification Google, disproportionnée
   pour un usage personnel.
3. **Identifiants → ID client OAuth**, type *Application Web*. Ajouter l'URL
   exacte de déploiement dans **Origines JavaScript autorisées**
   (ex. `https://<utilisateur>.github.io`). L'app affiche l'origine à autoriser
   dans le dialogue de configuration.
4. **Identifiants → Clé API**. La restreindre **par référent HTTP** à l'URL de
   déploiement : c'est ce qui empêche un tiers de la réutiliser ailleurs.
5. Noter le **numéro du projet** (App ID), requis par le Picker.

### Points de vigilance

- **Scope `drive.file`, pas `drive.readonly`.** `drive.file` est classé « non
  sensible » : pas d'audit de sécurité, pas de vidéo de démo, pas de politique de
  confidentialité à fournir. Combiné au Picker, il donne accès aux fichiers que
  vous sélectionnez explicitement, y compris ceux que l'app n'a pas créés.
- **Pas d'accès hors-ligne.** En mode Test, les jetons de rafraîchissement
  expirent au bout de 7 jours. L'app demande un jeton d'accès à la volée, via
  popup, à chaque session : ce flux n'est pas concerné par cette limite.
- **Popup iOS.** Safari bloque la popup OAuth si elle n'est pas ouverte
  *strictement* dans le gestionnaire de tap. Le bouton *Drive* appelle donc
  `requestAccessToken()` sans aucun `await` en amont, et les scripts Google sont
  préchargés au démarrage.

---

## Utilisation

| Geste / bouton | Effet |
| --- | --- |
| 2 doigts | Déplacer et zoomer, quel que soit l'outil actif |
| Double-tap | Zoom avant, ou retour à l'ajustement écran si déjà zoomé |
| **Naviguer** + 1 doigt | Déplacer le plan |
| **Mesurer** + 1 doigt | Tracer une cote ; l'axe (H ou V) est choisi selon le sens du geste |
| **Sélection** + 1 doigt | Sélectionner, déplacer un meuble, tirer l'extrémité d'une cote |
| **Meuble** | Créer un rectangle aux dimensions réelles saisies |
| **Échelle** | Choisir 1/N, ou calibrer sur une cote connue du plan |
| **Export** | Générer le PDF annoté, puis *Partager* (feuille iOS) ou *Télécharger* |

**Accrochage** : actif si le PDF contient des tracés vectoriels (export direct
depuis Archicad, AutoCAD…). Pendant une cote contrainte, l'accrochage cherche les
intersections entre la ligne de cote et les tracés du plan — on obtient donc la
distance exacte de mur à mur. Si le PDF est un scan, l'app le détecte à l'import,
signale l'absence de tracés et active la grille magnétique.

**Échelle** : par défaut, la conversion suppose que le PDF a été tracé à taille
réelle (1 pt = 1/72 pouce). Si le plan a été redimensionné à l'export ou à
l'impression, utilisez **Échelle → Calibrer sur une cote connue**.

> À vérifier avant de se fier à l'accrochage : les PDF doivent être des exports
> natifs d'un logiciel de CAO, pas des scans. La barre d'état affiche le nombre
> de tracés détectés (« sans tracés vectoriels » = scan).

---

## Notes de conception iPad

- `touch-action: none` sur la zone de rendu et `overscroll-behavior: none` :
  sans ça, le pan à deux doigts fait défiler la page avec l'effet élastique natif.
- Viewport en `maximum-scale=1, user-scalable=no` : désactive le zoom natif de
  Safari, qui se superposerait au zoom de l'app.
- `env(safe-area-inset-*)` sur les barres, et aucun bouton important collé aux
  bords de l'écran (conflit avec les gestes système : retour à l'accueil,
  Slide Over).
- Champs de saisie en 16 px minimum : en dessous, iOS zoome automatiquement sur
  le champ.
- Le bitmap de la page est plafonné à ~14 Mpx et re-rendu à la définition utile
  après chaque zoom. Pour du A3/A4 le plafond n'est jamais atteint ; il protège
  d'un plantage mémoire si un A0 est importé un jour.
