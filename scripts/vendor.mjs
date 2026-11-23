// Rebuilds public/vendor/*.js from the pinned devDependencies (npm ci && npm run vendor).
// The output is committed, so the site needs no CDN and no install step to deploy.
import { build } from 'esbuild';

for (const name of ['three']) {
  await build({
    entryPoints: [`scripts/vendor/${name}.js`],
    outfile: `public/vendor/${name}.js`,
    bundle: true,
    format: 'esm',
    minify: true,
    legalComments: 'inline',
    target: 'es2020',
    banner: { js: `// Bundled by scripts/vendor.mjs from npm packages pinned in package.json. Do not edit.` },
  });
  console.log(`public/vendor/${name}.js`);
}
