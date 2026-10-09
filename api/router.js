import { HttpError } from './util.js';

const routes = [];

// pattern like '/api/lots/:id/damage'; every :id becomes a numeric argument after the body
export function route(method, pattern, handler) {
  routes.push({ method, regex: new RegExp(`^${pattern.replace(/:id/g, '(\\d+)')}$`), handler });
}

// used by the web server and by seed.js (which fills the database through the same rules)
export function dispatch(method, pathname, body = {}) {
  for (const r of routes) {
    const match = r.method === method && pathname.match(r.regex);
    if (match) return r.handler(body, ...match.slice(1).map(Number));
  }
  throw new HttpError(404, 'not found');
}
