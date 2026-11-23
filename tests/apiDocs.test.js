import { describe, it, expect } from 'vitest';
import { compare, routesFromCode } from '../scripts/checkApiDocs.js';

describe('API documentation', () => {
  it('finds every route group in the code', () => {
    const routes = routesFromCode();
    for (const r of ['GET /health', 'POST /api/v1/auth/refresh', 'GET /api/v1/me', 'PATCH /api/v1/training/plans/:/items/:', 'GET /api/v1/admin/jobs']) {
      expect(routes.has(r)).toBe(true);
    }
  });

  it('docs/API.md and the Postman collection list exactly the routes in the code', () => {
    expect(compare().problems).toEqual([]);
  });
});
