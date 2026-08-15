# Plans d'architecture — viewer PDF pour iPad
https://nvalettepro-sudo.github.io/ipad_plan_viewer/

PWA mono-utilisateur pour **visualiser, mesurer et annoter des plans d'architecture
PDF** sur iPad, à échelle connue (1/50, 1/100, …), avec import depuis Google Drive
et export du plan annoté sans perte.

Installée sur l'écran d'accueil, elle fonctionne hors ligne et conserve le travail
entre les sessions.

| Fonction | État |
| --- | --- |
| Navigation : pincer / pan 2 doigts / double-tap / ajustement écran / mini-carte | ✅ |
| Mesures contraintes H ou V, avec accrochage sur les tracés du PDF | ✅ |
| Échelle **par page** + calibration sur une cote imprimée | ✅ |
| Sélecteur de page à vignettes pour les PDF multi-pages | ✅ |
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
publie à chaque `push` sur la **branche par défaut** du dépôt, quel que soit son nom.

1. Dépôt → **Settings → Pages → Source : GitHub Actions**.
2. Optionnel, pour préremplir les identifiants Google : **Settings → Secrets and
   variables → Actions**, ajouter `VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_API_KEY`,
   `VITE_GOOGLE_APP_ID`.
3. `git push` → l'URL est `https://<utilisateur>.github.io/<dépôt>/`.

Le workflow positionne `BASE_PATH=/<dépôt>/` : indispensable, sinon les assets et
le service worker renvoient des 404 sous GitHub Pages.

> ⚠️ **Dépôt privé + GitHub Pages** : sur un compte GitHub Free, Pages ne publie
> que depuis un dépôt **public**. Si vous passez le dépôt en privé (recommandé
> pour ne pas exposer la configuration), déployez plutôt sur **Netlify** ou
> **Vercel** : leurs offres gratuites acceptent les dépôts privés.
>
> Notez que dans tous les cas, l'application publiée est accessible à qui
> connaît l'URL : ce sont vos *plans importés* qui restent privés, puisqu'ils ne
> quittent jamais l'iPad.

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

La barre du haut tient sur **une seule rangée** et ne garde que les trois
outils de dessin — ✋ *Naviguer*, 📏 *Mesurer*, 🛋️ *Meuble*. Tout le reste
(ouvrir, Drive, annuler, ajuster, échelle, export, pages, réglages) vit dans le
**menu ☰**, à gauche. Sur téléphone la barre débordait sinon sur deux rangées,
au détriment du plan. Une pastille orange sur le ☰ signale qu'une page attend
encore sa calibration d'échelle.

| Geste / bouton | Effet |
| --- | --- |
| 2 doigts | Déplacer et zoomer, quel que soit l'outil actif |
| Double-tap | Zoom avant, ou retour à l'ajustement écran si déjà zoomé |
| **Naviguer** + glisser | Déplacer le plan — y compris en partant d'un objet |
| **Naviguer** + appui simple | Sélectionner l'objet sous le doigt ; le vide désélectionne |
| Glisser l'objet **déjà sélectionné** | Le déplacer (seul cas où un objet bouge) |
| Pastille **✏️** de la barre du bas | Déplier / replier le panneau d'édition de l'objet |
| **Mesurer** + 1 doigt | Tracer une cote ; l'axe (H ou V) est choisi selon le sens du geste |
| ☰ → **Annuler** ↩︎ | Défaire la dernière action, quelle qu'elle soit (⌘Z au clavier) |
| Bascule **Cotes** | Masquer les dimensions du mobilier, en gardant les noms |
| Bascule **Grille** + pastille **1 m / 50 cm** | Afficher le quadrillage et changer son pas |
| Glisser le **point bleu** | Déplacer l'origine de la grille (s'accroche aux angles) |
| **Meuble** | Créer un rectangle aux dimensions réelles saisies |
| ☰ → **Échelle** | Choisir 1/N, ou calibrer sur une cote connue du plan |
| ☰ → **Export** | Générer le PDF annoté, puis *Partager* (feuille iOS) ou *Télécharger* |

**Sélection et déplacement** : un glissement navigue *toujours* dans le plan,
même en partant d'un meuble ou d'une cote. Pour déplacer un objet, il faut
d'abord le sélectionner d'un appui simple — il devient alors le seul à suivre le
doigt. C'est ce qui évite de décaler une cote sans s'en apercevoir en voulant
simplement se déplacer dans le plan. L'objet sélectionné ouvre un panneau
d'édition : dimensions réelles, rotation 90°, couleur, nom, duplication,
suppression ; pour une cote, sa longueur exacte.

Sur téléphone, ce panneau **s'ouvre replié** : il occuperait la moitié de
l'écran, précisément au moment où l'on veut voir le plan qu'on vient de
désigner. Une pastille ✏️ apparaît alors dans la barre du bas, à la place des
informations du document, et le déplie à la demande. La replier ne
désélectionne pas : l'objet reste manipulable au doigt.

**Les étiquettes s'effacent au lieu de grossir.** Nom, dimensions et valeurs de
cote gardent une taille constante à l'écran : c'est ce qu'on attend d'une
annotation, mais en dézoomant elles finiraient par être plus grandes que les
objets qu'elles décrivent et masqueraient le plan. Chaque étiquette est donc
mesurée avant d'être tracée, et n'est dessinée que si elle **tient dans**
l'objet : à l'intérieur du rectangle pour un meuble, dans la longueur de la
ligne pour une cote. Quand la place ne suffit que pour une seule ligne, le
**nom du meuble prime** sur ses dimensions ; en dessous, plus rien ne
s'affiche. Rien n'est perdu : la valeur d'une cote en cours de tracé reste
lisible dans le bandeau, et l'objet sélectionné affiche tout dans son panneau
d'édition. L'export PDF, lui, est fait à l'échelle native de la planche : il
porte toutes les étiquettes.

**Un meuble se plaque contre un mur.** En le faisant glisser, ses arêtes sont
attirées par les tracés du plan qui leur font face — et par ceux-là seulement,
pas par un mur situé dans leur prolongement. Une seule correction par axe est
retenue, la plus faible, pour ne pas tirailler le rectangle entre deux murs
opposés. Les arêtes effectivement collées s'affichent en vert pendant le geste.

**Une cote va toujours d'un trait à l'autre.** L'axe du geste fixe la ligne de
cote ; ses deux extrémités se posent ensuite sur les tracés que cette ligne
rencontre, chacune sur le plus proche du doigt. La recherche s'élargit tant
qu'aucun tracé n'est trouvé, de sorte qu'une extrémité ne reste jamais « en
l'air ». Une extrémité déjà posée se reprend en tirant sa poignée : elle
conserve l'axe et se raccroche à un autre trait. Les **arêtes des meubles déjà
posés** comptent comme des traits : on cote donc aussi bien d'un mur à un
meuble que de mur à mur. Décochez **Accrochage** pour retrouver un placement
libre (indispensable sur un PDF scanné).

**La grille a une origine visible et déplaçable.** Quand elle est affichée, un
point bleu cerclé de blanc — la même poignée que sur les angles des meubles —
marque le point d'où part le quadrillage, avec deux amorces d'axes en
pointillés. Faites-le glisser pour caler la grille où vous voulez : il
s'accroche en priorité aux **angles** du plan (deux tracés qui se rencontrent),
puis aux tracés simples. Le repère d'accrochage prend la forme d'une croix
verte sur un angle, d'un carré sur une extrémité, d'un cercle sur un bord.

Le pas se choisit entre **1 m et 50 cm** par la pastille voisine de la case
*Grille*. Origine et pas sont enregistrés par page.

**Accrochage** : actif si le PDF contient des tracés vectoriels (export direct
depuis Archicad, AutoCAD…). Pendant une cote contrainte, l'accrochage cherche les
intersections entre la ligne de cote et les tracés du plan — on obtient donc la
distance exacte de mur à mur. Si le PDF est un scan, l'app le détecte à l'import,
signale l'absence de tracés et active la grille magnétique.

**Documents multi-pages** : à l'import, l'app affiche les pages en vignettes et
demande laquelle ouvrir — un numéro de page ne dit rien sur un carnet, il faut
voir la planche. Seule la page choisie est chargée et indexée, puis son échelle
est demandée dans la foulée. Chaque vignette rappelle l'échelle déjà réglée et
le nombre d'annotations posées.

**Échelle** : elle est enregistrée **par page**, parce qu'un carnet de détails
change d'échelle d'une planche à l'autre. Tant qu'une page n'a pas été
calibrée, une **pastille orange** apparaît sur le ☰ et l'entrée *Échelle* du
menu affiche un **« ? »** : la valeur affichée n'est qu'un héritage de la page
précédente, pas une mesure fiable.

---

## Ce que disent les PDF Archicad réels (mesuré, pas supposé)

Deux exports Archicad ont été passés dans le pipeline de l'app.

| | Plan de masse A4 | Carnet de détails A3 |
| --- | --- | --- |
| Format | 842 × 595 pt (A4 paysage) | 1191 × 842 pt (A3 paysage), 3 pages |
| Images bitmap | **0** | **0** |
| Tracés vectoriels extraits | 2 047 | 56 577 (page 1) |
| Échelle imprimée sur la planche | aucune | aucune |
| Échelle réelle mesurée | **≈ 1/62** | **≈ 1/10** (majorité des cotes) |
| Import + 1er rendu | < 0,5 s | ~1,0 s |
| Extraction + index d'accrochage | < 0,2 s | ~1,0 s |

### 1. L'accrochage est utilisable — c'est validé

Aucun des deux fichiers ne contient d'image : ce sont des exports vectoriels
natifs. L'accrochage sur les tracés fonctionne, y compris sur la planche à
56 000 segments.

### 2. En revanche, l'échelle nominale n'est pas fiable

Aucune des deux planches n'imprime son échelle, et **le plan A4 n'est pas à une
échelle ronde** : il mesure 1/62. Une mesure faite en supposant 1/50 aurait été
fausse de −19 % — soit 80 cm d'erreur sur une pièce de 4 m, sans le moindre
signe d'alerte.

Après calibration sur la cote imprimée « 400 », l'app déduit 1/62 et **toutes
les cotes vérifiables retombent exactement juste** :

| Cote imprimée | Mesurée par l'app | Écart |
| --- | --- | --- |
| 400 cm | 400,0 cm | 0,0 % |
| 350 cm | 350,0 cm | 0,0 % |
| 130 cm | 130,0 cm | 0,0 % |
| 100 cm | 100,0 cm | 0,0 % |

**Règle d'usage : calibrez systématiquement sur une cote imprimée, puis
vérifiez sur une seconde cote du même dessin.** Le dialogue d'échelle propose
la calibration en premier pour cette raison.

### 3. Limite connue : plusieurs échelles sur une même planche

Sur le carnet de détails, la majorité des cotes de la page 1 donnent ≈ 1/10,
mais quelques-unes ne collent pas à ce ratio : une planche de détails peut
mélanger plusieurs échelles côte à côte. L'app gère **une échelle par page**,
pas par zone.

Concrètement, sur ce type de planche : calibrez sur une cote **du détail que
vous êtes en train de mesurer**, et recalibrez en changeant de détail. Une
échelle par zone serait la réponse propre — à envisager en v2 si l'usage le
justifie.

> La barre d'état affiche le nombre de tracés détectés. « sans tracés
> vectoriels » signifie que le PDF est un scan : l'accrochage est alors
> impossible et la grille magnétique prend le relais.

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
