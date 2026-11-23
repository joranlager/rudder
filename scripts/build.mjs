// Builds the static site into dist/ for GitHub Pages. There is no backend.
import { cp, rm, readFile, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await cp('public', 'dist', { recursive: true });
// Stops Pages from running Jekyll, which would hide files starting with an underscore.
await writeFile('dist/.nojekyll', '');

// Stamp the page with the branch and commit being deployed: all branches deploy, the last one wins.
const sha = (process.env.GITHUB_SHA ?? 'local').slice(0, 7);
const branch = process.env.GITHUB_REF_NAME ?? '';
const build = branch ? `${branch} ${sha}` : sha;
const html = await readFile('dist/index.html', 'utf8');
await writeFile('dist/index.html', html.replace('__BUILD__', build.replace(/[<>&"]/g, '')));

console.log(`Built dist/ (${build})`);
