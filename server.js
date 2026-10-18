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
const CODE_PREFIX = process.env.CODE_PREFIX ?? 'VW-';
// Fuso usado para definir o "dia do cadastro" (cada evento sorteia só entre os cadastros do seu dia).
const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'sorteio.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!ADMIN_PASSWORD) {
  console.warn('[aviso] ADMIN_PASSWORD não definido: a área /admin ficará bloqueada.');
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
const PARTICIPANTES_SQL = (nome) => `
  CREATE TABLE ${nome} (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    nome           TEXT NOT NULL,
    cpf            TEXT NOT NULL,
    telefone       TEXT NOT NULL,
    email          TEXT,
    data_cadastro  TEXT NOT NULL,
    criado_em      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (cpf, data_cadastro)
  )`;

db.exec('PRAGMA journal_mode = WAL');
const colunas = db.prepare('PRAGMA table_info(participantes)').all().map((c) => c.name);
if (!colunas.length) {
  db.exec(PARTICIPANTES_SQL('participantes'));
} else if (!colunas.includes('data_cadastro')) {
  // Banco de uma versão anterior (CPF único para sempre): passa a ser um cadastro por CPF por dia.
  // As chaves estrangeiras precisam ficar desligadas durante a troca da tabela (fora da transação).
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    BEGIN;
    ${PARTICIPANTES_SQL('participantes_novo')};
    INSERT INTO participantes_novo (id, nome, cpf, telefone, email, data_cadastro, criado_em)
      SELECT id, nome, cpf, telefone, email, date(criado_em, '-3 hours'), criado_em FROM participantes;
    DROP TABLE participantes;
    ALTER TABLE participantes_novo RENAME TO participantes;
    COMMIT;
  `);
  db.exec('PRAGMA foreign_keys = ON');
}
db.exec(`
  CREATE INDEX IF NOT EXISTS participantes_data ON participantes (data_cadastro);
  CREATE TABLE IF NOT EXISTS sorteios (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    participante_id INTEGER NOT NULL REFERENCES participantes(id),
    sorteado_em     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const q = {
  insert: db.prepare(`
    INSERT INTO participantes (nome, cpf, telefone, email, data_cadastro) VALUES (?, ?, ?, ?, ?)`),
  byCpfDia: db.prepare('SELECT id, nome FROM participantes WHERE cpf = ? AND data_cadastro = ?'),
  all: db.prepare(`
    SELECT id, nome, cpf, telefone, email, data_cadastro, criado_em FROM participantes ORDER BY id`),
  byDate: db.prepare(`
    SELECT id, nome, cpf, telefone, email, data_cadastro, criado_em FROM participantes
    WHERE data_cadastro = ? ORDER BY id`),
  datas: db.prepare(`
    SELECT data_cadastro AS data, COUNT(*) AS total FROM participantes
    GROUP BY data_cadastro ORDER BY data_cadastro DESC`),
  eligible: db.prepare(`
    SELECT id FROM participantes
    WHERE id NOT IN (SELECT participante_id FROM sorteios)
    ORDER BY id`),
  eligibleByDate: db.prepare(`
    SELECT id FROM participantes
    WHERE data_cadastro = ? AND id NOT IN (SELECT participante_id FROM sorteios)
    ORDER BY id`),
  byId: db.prepare(`
    SELECT id, nome, cpf, telefone, email, data_cadastro, criado_em FROM participantes WHERE id = ?`),
  insertDraw: db.prepare('INSERT INTO sorteios (participante_id) VALUES (?)'),
  draws: db.prepare(`
    SELECT s.id AS sorteio, s.sorteado_em, p.id, p.nome, p.cpf, p.telefone, p.email, p.data_cadastro
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

// "AAAA-MM-DD" no fuso configurado.
const formatoDia = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
function hoje() {
  return formatoDia.format(new Date());
}

function dataParam(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : null;
}

function codigo(id) {
  return CODE_PREFIX + String(id).padStart(4, '0');
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
  if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push('Informe um e-mail válido.');
  }
  if (body.aceite !== true) errors.push('É preciso aceitar os termos para participar.');
  return { nome, cpf, telefone, email, errors };
}

// ---------- rotas ----------

const routes = {
  'GET /api/config': (req, res) => json(res, 200, { evento: EVENT_NAME, prefixo: CODE_PREFIX, hoje: hoje() }),

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

    // Um cadastro por CPF por dia: quem volta em outro evento (outro dia) ganha um código novo.
    const dia = hoje();
    const existing = q.byCpfDia.get(data.cpf, dia);
    if (existing) {
      return json(res, 200, { id: existing.id, nome: existing.nome, data_cadastro: dia, jaCadastrado: true });
    }
    const r = q.insert.run(data.nome, data.cpf, data.telefone, data.email, dia);
    return json(res, 201, { id: Number(r.lastInsertRowid), nome: data.nome, data_cadastro: dia, jaCadastrado: false });
  },

  'GET /api/admin/participantes': (req, res) => {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { participantes: q.all.all(), sorteios: q.draws.all(), datas: q.datas.all(), hoje: hoje() });
  },

  'GET /api/admin/participantes.csv': (req, res) => {
    if (!requireAdmin(req, res)) return;
    const dia = dataParam(new URL(req.url, 'http://localhost').searchParams.get('data'));
    const rows = dia ? q.byDate.all(dia) : q.all.all();
    const lines = [['codigo', 'nome', 'cpf', 'telefone', 'email', 'data_cadastro', 'criado_em_utc'].join(',')];
    for (const r of rows) {
      lines.push([codigo(r.id), r.nome, r.cpf, r.telefone, r.email, r.data_cadastro, r.criado_em].map(csvCell).join(','));
    }
    send(res, 200, '\uFEFF' + lines.join('\r\n'), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="participantes${dia ? '-' + dia : ''}.csv"`,
    });
  },

  'POST /api/admin/sortear': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readJson(req).catch(() => ({}));
    // Com "data", só concorrem os cadastros feitos naquele dia (o dia do evento).
    const dia = dataParam(body.data);
    const pool = dia ? q.eligibleByDate.all(dia) : q.eligible.all();
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
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
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
