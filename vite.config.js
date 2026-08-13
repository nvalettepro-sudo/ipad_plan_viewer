import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { defineConfig } from 'vite';

// Chemin de base : '/' pour Netlify/Vercel, '/<nom-du-depot>/' pour GitHub Pages.
// Le workflow GitHub Actions positionne BASE_PATH automatiquement.
const base = process.env.BASE_PATH || '/';

/** Liste récursivement les fichiers d'un dossier, en chemins relatifs POSIX. */
function walk(dir, root = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walk(abs, root));
    else out.push(relative(root, abs).split(sep).join(posix.sep));
  }
  return out;
}

// Ressources PDF.js servies à la demande (polices standard et tables cmap).
// Elles sont volumineuses et rarement toutes nécessaires : on les expose sans
// les copier dans le dépôt, et le service worker les met en cache à l'usage.
const PDFJS_ASSETS = [
  ['cmaps', 'node_modules/pdfjs-dist/cmaps'],
  ['standard_fonts', 'node_modules/pdfjs-dist/standard_fonts'],
];

function pdfjsAssetsPlugin() {
  return {
    name: 'plan-viewer-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = /\/pdfjs\/(cmaps|standard_fonts)\/(.+)$/.exec(req.url || '');
        if (!match) return next();
        const [, kind, file] = match;
        const dir = PDFJS_ASSETS.find(([name]) => name === kind)?.[1];
        const abs = join(process.cwd(), dir, decodeURIComponent(file));
        if (!abs.startsWith(join(process.cwd(), dir))) return next();
        try {
          const body = readFileSync(abs);
          res.setHeader('Content-Type', 'application/octet-stream');
          res.end(body);
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const [name, dir] of PDFJS_ASSETS) {
        const root = join(process.cwd(), dir);
        for (const file of walk(root)) {
          this.emitFile({
            type: 'asset',
            fileName: `pdfjs/${name}/${file}`,
            source: readFileSync(join(root, file)),
          });
        }
      }
    },
  };
}

/**
 * Génère `sw.js` après le build.
 *
 * Le service worker est écrit à partir de `scripts/sw-template.js` : on y injecte
 * la liste des fichiers à précacher et une version dérivée du contenu du build.
 * Comme la version change à chaque build, le navigateur détecte un `sw.js`
 * différent et déclenche `updatefound` -> bandeau « Mise à jour disponible ».
 */
function serviceWorkerPlugin() {
  return {
    name: 'plan-viewer-service-worker',
    apply: 'build',
    closeBundle() {
      const outDir = join(process.cwd(), 'dist');
      const files = walk(outDir)
        .filter((f) => f !== 'sw.js' && !f.endsWith('.map') && !f.startsWith('pdfjs/'))
        .sort();

      const hash = createHash('sha256');
      for (const file of files) {
        hash.update(file);
        hash.update(readFileSync(join(outDir, file)));
      }
      const version = hash.digest('hex').slice(0, 12);

      const urls = files.map((f) => (f === 'index.html' ? base : base + f));
      // Dédoublonne : `base` remplace 'index.html'.
      const precache = [...new Set(urls)];

      const template = readFileSync(join(process.cwd(), 'scripts', 'sw-template.js'), 'utf8');
      const sw = template
        .replace('__SW_VERSION__', version)
        .replace('__SW_BASE__', base)
        .replace('"__SW_PRECACHE__"', JSON.stringify(precache, null, 2));

      writeFileSync(join(outDir, 'sw.js'), sw);
      this.info?.(`sw.js généré (version ${version}, ${precache.length} fichiers précachés)`);
    },
  };
}

export default defineConfig({
  base,
  define: {
    __APP_BASE__: JSON.stringify(base),
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    // pdf.js + pdf-lib sont volumineux : on assume des chunks > 500 kB.
    chunkSizeWarningLimit: 1500,
  },
  server: {
    host: true,
  },
  plugins: [pdfjsAssetsPlugin(), serviceWorkerPlugin()],
});
