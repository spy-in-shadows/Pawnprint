// Checks that docs/API.md and docs/pawnprint.postman_collection.json list exactly the endpoints
// defined in src/app.js and src/routes. Usage: npm run check:api-docs (exits 1 on a mismatch).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ROUTE_CALL = /\b(app|router)\.(get|post|patch|put|delete)\(\s*'([^']+)'/g;

// Express ':param' and Postman '{{var}}' both become ':' so the paths can be compared.
const normalise = (p) => p.replace(/\{\{[^}]+\}\}/g, ':').replace(/:[A-Za-z]+/g, ':').replace(/\/$/, '') || '/';

export function routesFromCode() {
  const routes = new Set();
  for (const [, , method, p] of read('src/app.js').matchAll(ROUTE_CALL)) routes.add(`${method.toUpperCase()} ${normalise(p)}`);

  const index = read('src/routes/v1/index.js');
  const imports = Object.fromEntries([...index.matchAll(/import (\w+) from '\.\.\/([\w.]+)'/g)].map(([, name, file]) => [name, file]));
  for (const [, , method, p] of index.matchAll(ROUTE_CALL)) routes.add(`${method.toUpperCase()} ${normalise(`/api/v1${p}`)}`);
  for (const [, prefix, name] of index.matchAll(/router\.use\('([^']+)',\s*(\w+)\)/g)) {
    const source = read(path.join('src/routes', imports[name]));
    for (const [, , method, p] of source.matchAll(ROUTE_CALL)) {
      routes.add(`${method.toUpperCase()} ${normalise(`/api/v1${prefix}${p === '/' ? '' : p}`)}`);
    }
  }
  return routes;
}

export function routesFromMarkdown() {
  const routes = new Set();
  for (const [, method, p] of read('docs/API.md').matchAll(/^\| (GET|POST|PATCH|PUT|DELETE) \| `([^`]+)` \|/gm)) {
    routes.add(`${method} ${normalise(p)}`);
  }
  return routes;
}

export function routesFromPostman() {
  const routes = new Set();
  const walk = (items) => {
    for (const item of items) {
      if (item.item) walk(item.item);
      else routes.add(`${item.request.method} ${normalise(`/${item.request.url.path.join('/')}`)}`);
    }
  };
  walk(JSON.parse(read('docs/pawnprint.postman_collection.json')).item);
  return routes;
}

export function compare() {
  const code = routesFromCode();
  const problems = [];
  for (const [label, documented] of [['docs/API.md', routesFromMarkdown()], ['Postman collection', routesFromPostman()]]) {
    for (const r of code) if (!documented.has(r)) problems.push(`${label} is missing ${r}`);
    for (const r of documented) if (!code.has(r)) problems.push(`${label} lists ${r}, which no route defines`);
  }
  return { routes: [...code].sort(), problems };
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  const { routes, problems } = compare();
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  console.log(`API docs match the ${routes.length} routes in the code.`);
}
