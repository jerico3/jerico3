'use strict';

// Servidor sem dependências externas: usa apenas módulos nativos do Node (>= 22.13).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const EVENT_NAME = process.env.EVENT_NAME || 'Sorteio';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'sorteio.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!ADMIN_PASSWORD) {
  console.warn('[aviso] ADMIN_PASSWORD não definido: a área /admin ficará bloqueada.');
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS participantes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    nome       TEXT NOT NULL,
    cpf        TEXT NOT NULL UNIQUE,
    telefone   TEXT NOT NULL,
    email      TEXT,
    criado_em  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sorteios (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    participante_id INTEGER NOT NULL REFERENCES participantes(id),
    sorteado_em     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const q = {
  insert: db.prepare('INSERT INTO participantes (nome, cpf, telefone, email) VALUES (?, ?, ?, ?)'),
  byCpf: db.prepare('SELECT id, nome FROM participantes WHERE cpf = ?'),
  all: db.prepare('SELECT id, nome, cpf, telefone, email, criado_em FROM participantes ORDER BY id'),
  count: db.prepare('SELECT COUNT(*) AS total FROM participantes'),
  eligible: db.prepare(`
    SELECT id FROM participantes
    WHERE id NOT IN (SELECT participante_id FROM sorteios)
    ORDER BY id`),
  byId: db.prepare('SELECT id, nome, cpf, telefone, email, criado_em FROM participantes WHERE id = ?'),
  insertDraw: db.prepare('INSERT INTO sorteios (participante_id) VALUES (?)'),
  draws: db.prepare(`
    SELECT s.id AS sorteio, s.sorteado_em, p.id, p.nome, p.cpf, p.telefone, p.email
    FROM sorteios s JOIN participantes p ON p.id = s.participante_id
    ORDER BY s.id`),
  clearDraws: db.prepare('DELETE FROM sorteios'),
};

// ---------- utilitários HTTP ----------

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

function json(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readJson(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload grande demais'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const password = decoded.slice(decoded.indexOf(':') + 1);
  const a = crypto.createHash('sha256').update(password).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  send(res, 401, 'Acesso restrito', {
    'WWW-Authenticate': 'Basic realm="Admin do sorteio", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  return false;
}

// Limite simples de tentativas de cadastro por IP (janela de 10 minutos).
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const list = (attempts.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  attempts.set(ip, list);
  return list.length > 20;
}
setInterval(() => attempts.clear(), 60 * 60 * 1000).unref();

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  // Evita injeção de fórmulas ao abrir o CSV no Excel/Sheets.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

// ---------- validação ----------

function cpfValido(cpf) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const len of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < len; i++) soma += Number(cpf[i]) * (len + 1 - i);
    const digito = ((soma * 10) % 11) % 10;
    if (digito !== Number(cpf[len])) return false;
  }
  return true;
}

function normalize(body) {
  const nome = String(body.nome || '').trim().replace(/\s+/g, ' ');
  const cpf = String(body.cpf || '').replace(/\D/g, '');
  const telefone = String(body.telefone || '').replace(/\D/g, '');
  const email = String(body.email || '').trim().toLowerCase();
  const errors = [];
  if (nome.length < 3 || nome.length > 120) errors.push('Informe seu nome completo.');
  if (!cpfValido(cpf)) errors.push('Informe um CPF válido.');
  if (telefone.length < 10 || telefone.length > 13) errors.push('Informe um telefone válido com DDD.');
  if (email && (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    errors.push('Informe um e-mail válido.');
  }
  if (body.aceite !== true) errors.push('É preciso aceitar os termos para participar.');
  return { nome, cpf, telefone, email: email || null, errors };
}

// ---------- rotas ----------

const routes = {
  'GET /api/config': (req, res) => json(res, 200, { evento: EVENT_NAME }),

  'POST /api/cadastro': async (req, res) => {
    if (rateLimited(clientIp(req))) {
      return json(res, 429, { erro: 'Muitas tentativas. Aguarde alguns minutos.' });
    }
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return json(res, 400, { erro: e.message });
    }
    // Campo "isca" invisível: bots costumam preenchê-lo.
    if (body.site) return json(res, 400, { erro: 'Cadastro inválido.' });

    const data = normalize(body);
    if (data.errors.length) return json(res, 422, { erro: data.errors.join(' ') });

    const existing = q.byCpf.get(data.cpf);
    if (existing) {
      return json(res, 200, { id: existing.id, nome: existing.nome, jaCadastrado: true });
    }
    try {
      const r = q.insert.run(data.nome, data.cpf, data.telefone, data.email);
      return json(res, 201, { id: Number(r.lastInsertRowid), nome: data.nome, jaCadastrado: false });
    } catch (e) {
      // Corrida entre duas requisições com o mesmo CPF.
      const again = q.byCpf.get(data.cpf);
      if (again) return json(res, 200, { id: again.id, nome: again.nome, jaCadastrado: true });
      throw e;
    }
  },

  'GET /api/admin/participantes': (req, res) => {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { total: q.count.get().total, participantes: q.all.all(), sorteios: q.draws.all() });
  },

  'GET /api/admin/participantes.csv': (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = q.all.all();
    const lines = [['id', 'nome', 'cpf', 'telefone', 'email', 'criado_em'].join(',')];
    for (const r of rows) lines.push([r.id, r.nome, r.cpf, r.telefone, r.email, r.criado_em].map(csvCell).join(','));
    send(res, 200, '﻿' + lines.join('\r\n'), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="participantes.csv"',
    });
  },

  'POST /api/admin/sortear': (req, res) => {
    if (!requireAdmin(req, res)) return;
    const pool = q.eligible.all();
    if (!pool.length) return json(res, 409, { erro: 'Não há participantes elegíveis para sortear.' });
    // crypto.randomInt usa um gerador criptograficamente seguro e sem viés.
    const winnerId = pool[crypto.randomInt(pool.length)].id;
    q.insertDraw.run(winnerId);
    json(res, 200, { vencedor: q.byId.get(winnerId), elegiveis: pool.length });
  },

  'POST /api/admin/reiniciar-sorteios': (req, res) => {
    if (!requireAdmin(req, res)) return;
    q.clearDraws.run();
    json(res, 200, { ok: true });
  },

  'GET /admin': (req, res) => {
    if (!requireAdmin(req, res)) return;
    serveFile(res, 'admin.html');
  },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveFile(res, rel) {
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Não encontrado');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Não encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const handler = routes[`${req.method} ${pathname}`];
  try {
    if (handler) return await handler(req, res);
    if (req.method !== 'GET') return send(res, 405, 'Método não permitido');
    if (pathname === '/' || pathname === '/index.html') return serveFile(res, 'index.html');
    if (pathname === '/admin.html') return send(res, 302, '', { Location: '/admin' });
    return serveFile(res, decodeURIComponent(pathname).replace(/^\/+/, ''));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { erro: 'Erro interno. Tente novamente.' });
  }
});

server.listen(PORT, () => {
  console.log(`Sorteio "${EVENT_NAME}" rodando em http://localhost:${PORT}`);
  console.log(`Área administrativa: http://localhost:${PORT}/admin`);
});
