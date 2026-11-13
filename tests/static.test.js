import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/app.js';

describe('Static client serving and request logging', () => {
  let app;
  let server;
  let baseUrl;
  let tempDist;
  let loggedOutput = [];
  let originalStdoutWrite;

  beforeAll(async () => {
    // Intercept process.stdout.write to verify requestLogger output
    originalStdoutWrite = process.stdout.write;
    process.stdout.write = (chunk, ...args) => {
      loggedOutput.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return originalStdoutWrite.call(process.stdout, chunk, ...args);
    };

    // Create a temporary mock client dist directory
    tempDist = fs.mkdtempSync(path.join(os.tmpdir(), 'pawnprint-dist-'));
    fs.writeFileSync(path.join(tempDist, 'index.html'), '<!DOCTYPE html><html><body>SPA Root</body></html>');
    fs.writeFileSync(path.join(tempDist, 'asset.js'), 'console.log("asset");');

    app = createApp({
      clientDistPath: tempDist,
    });

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    process.stdout.write = originalStdoutWrite;
    await new Promise((resolve) => server.close(resolve));
    if (tempDist && fs.existsSync(tempDist)) {
      fs.rmSync(tempDist, { recursive: true, force: true });
    }
  });

  it('serves static assets and falls back to index.html for non-/api routes like /dashboard', async () => {
    // Exact static asset
    const resAsset = await fetch(`${baseUrl}/asset.js`);
    expect(resAsset.status).toBe(200);
    const textAsset = await resAsset.text();
    expect(textAsset).toContain('console.log("asset");');

    // SPA fallback: /dashboard should return index.html
    const resDashboard = await fetch(`${baseUrl}/dashboard`);
    expect(resDashboard.status).toBe(200);
    const html = await resDashboard.text();
    expect(html).toContain('SPA Root');
  });

  it('unknown /api routes never fall through to index.html and return JSON 404', async () => {
    const resApi = await fetch(`${baseUrl}/api/v1/nope`);
    expect(resApi.status).toBe(404);
    const json = await resApi.json();
    expect(json.error).toBeDefined();
    expect(json.error.code).toBe('NOT_FOUND');
  });

  it('request logger writes one JSON line per request without logging authorization or passwords', async () => {
    loggedOutput = [];

    const res = await fetch(`${baseUrl}/api/v1/nope`, {
      headers: {
        Authorization: 'Bearer super_secret_token_12345',
      },
    });
    expect(res.status).toBe(404);

    // Give finish event time to write log
    await new Promise((resolve) => setTimeout(resolve, 50));

    const line = loggedOutput.find((str) => str.includes('/api/v1/nope'));
    expect(line).toBeDefined();
    expect(line).toContain('HTTP request');
    expect(line).toContain('"status":404');
    expect(line).toContain('"durationMs":');

    // Must never log Authorization header value
    expect(line).not.toContain('super_secret_token_12345');
  });
});
