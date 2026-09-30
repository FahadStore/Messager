// خادم دردشة عامة بدون أي اعتمادات خارجية (Node.js فقط)
// يستخدم Server-Sent Events للبث المباشر وطلبات POST لإرسال الرسائل.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'messages.json');
const HISTORY_LIMIT = 200;
const MAX_TEXT = 500;
const MAX_NAME = 24;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 8;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

let history = loadHistory();
const clients = new Map(); // id -> { res, name }
const rate = new Map(); // ip -> [timestamps]

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(data) ? data.slice(-HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(DATA_FILE, JSON.stringify(history), (err) => {
      if (err) console.error('تعذر حفظ الرسائل:', err.message);
    });
  }, 1000);
}

function clean(str, max) {
  return String(str ?? '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const { res } of clients.values()) res.write(payload);
}

function onlineCount() {
  return clients.size;
}

function isRateLimited(ip) {
  const now = Date.now();
  const list = (rate.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  rate.set(ip, list);
  return list.length > RATE_MAX;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0] : req.socket.remoteAddress || '').trim();
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function handleStream(req, res, url) {
  const id = crypto.randomUUID();
  const name = clean(url.searchParams.get('name'), MAX_NAME) || 'زائر';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n`);
  res.write(`event: history\ndata: ${JSON.stringify(history)}\n\n`);
  clients.set(id, { res, name });
  broadcast('presence', { online: onlineCount() });

  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(id);
    broadcast('presence', { online: onlineCount() });
  });
}

async function handlePost(req, res) {
  if (isRateLimited(clientIp(req))) {
    return sendJson(res, 429, { error: 'أنت ترسل بسرعة كبيرة، انتظر قليلًا.' });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'طلب غير صالح.' });
  }
  const name = clean(body.name, MAX_NAME);
  const text = clean(body.text, MAX_TEXT);
  const color = /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#6d5dfc';
  if (!name) return sendJson(res, 400, { error: 'اكتب اسمك أولًا.' });
  if (!text) return sendJson(res, 400, { error: 'الرسالة فارغة.' });

  const msg = { id: crypto.randomUUID(), name, text, color, time: Date.now() };
  history.push(msg);
  if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
  scheduleSave();
  broadcast('message', msg);
  sendJson(res, 201, { ok: true, id: msg.id });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('غير موجود');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/stream' && req.method === 'GET') return handleStream(req, res, url);
  if (url.pathname === '/api/messages' && req.method === 'POST') {
    return handlePost(req, res).catch(() => sendJson(res, 500, { error: 'خطأ في الخادم.' }));
  }
  if (req.method === 'GET') return serveStatic(req, res, url);
  res.writeHead(405);
  res.end();
});

setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of rate) {
    if (!list.some((t) => now - t < RATE_WINDOW_MS)) rate.delete(ip);
  }
}, 60_000).unref();

server.listen(PORT, () => {
  console.log(`الدردشة تعمل على http://localhost:${PORT}`);
});
