import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { handleApi } from './api.ts';
import { root } from './db/client.ts';
import { subscribe } from './services/events.ts';

const port = Number(process.env.PORT || 4317);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(root, 'dist', 'client');
const clientDevHtml = path.join(__dirname, '../client/index.html');

function contentType(filePath: string): string {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

async function serveStatic(reqPath: string, res: http.ServerResponse): Promise<boolean> {
  const candidates = [
    path.join(clientDist, reqPath === '/' ? 'index.html' : reqPath),
    path.join(clientDist, 'index.html')
  ];
  for (const file of candidates) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': contentType(file) });
      res.end(fs.readFileSync(file));
      return true;
    }
  }
  if (reqPath === '/' && fs.existsSync(clientDevHtml)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>AI 指挥台</title>
  <style>
    body{font-family:ui-sans-serif,system-ui;padding:48px;background:#0f1419;color:#e7ecf3}
    a{color:#3dd6c6}
  </style>
</head>
<body>
  <h1>AI 指挥台 API 已启动</h1>
  <p>开发 UI 请运行 <code>npm run dev</code>，然后打开 Vite 地址（默认 http://127.0.0.1:5173）。</p>
  <p>API：<a href="/api/health">/api/health</a></p>
</body>
</html>`);
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || `127.0.0.1:${port}`;
  const url = new URL(req.url || '/', `http://${host}`);

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url);
  }

  const served = await serveStatic(url.pathname, res);
  if (!served) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'connected', at: new Date().toISOString() }));
});

subscribe((event) => {
  const payload = JSON.stringify({ type: 'event', event });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`AI 指挥台已启动 http://127.0.0.1:${port}`);
});
