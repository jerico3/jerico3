'use strict';

// Servidor sem dependências externas: usa apenas módulos nativos do Node (>= 22.13).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
// Usados só para criar o primeiro administrador, quando ainda não existe nenhum usuário.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@sorteio.local').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const EVENT_NAME = process.env.EVENT_NAME || 'Sorteio';
const CODE_PREFIX = process.env.CODE_PREFIX ?? 'VW-';
// Fuso usado para definir o "dia do cadastro" (cada evento sorteia só entre os cadastros do seu dia).
const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'sorteio.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_HOURS = 12;

// ---------- banco de dados ----------

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
  CREATE TABLE IF NOT EXISTS usuarios (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nome        TEXT NOT NULL,
    email       TEXT NOT NULL UNIQUE,
    senha_hash  TEXT NOT NULL,
    papel       TEXT NOT NULL CHECK (papel IN ('admin', 'operador')),
    ativo       INTEGER NOT NULL DEFAULT 1,
    criado_em   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessoes (
    token_hash  TEXT PRIMARY KEY,
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira_em   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auditoria (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id    INTEGER,
    usuario_nome  TEXT,
    acao          TEXT NOT NULL,
    detalhe       TEXT,
    criado_em     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const PARTICIPANTE_COLS = 'id, nome, cpf, telefone, email, data_cadastro, criado_em';
const USUARIO_COLS = 'id, nome, email, papel, ativo, criado_em';

const q = {
  insert: db.prepare(`
    INSERT INTO participantes (nome, cpf, telefone, email, data_cadastro) VALUES (?, ?, ?, ?, ?)`),
  byCpfDia: db.prepare('SELECT id, nome FROM participantes WHERE cpf = ? AND data_cadastro = ?'),
  all: db.prepare(`SELECT ${PARTICIPANTE_COLS} FROM participantes ORDER BY id`),
  byDate: db.prepare(`SELECT ${PARTICIPANTE_COLS} FROM participantes WHERE data_cadastro = ? ORDER BY id`),
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
  byId: db.prepare(`SELECT ${PARTICIPANTE_COLS} FROM participantes WHERE id = ?`),
  update: db.prepare('UPDATE participantes SET nome = ?, cpf = ?, telefone = ?, email = ? WHERE id = ?'),
  delete: db.prepare('DELETE FROM participantes WHERE id = ?'),
  deleteDrawsOf: db.prepare('DELETE FROM sorteios WHERE participante_id = ?'),
  insertDraw: db.prepare('INSERT INTO sorteios (participante_id) VALUES (?)'),
  draws: db.prepare(`
    SELECT s.id AS sorteio, s.sorteado_em, p.id, p.nome, p.cpf, p.telefone, p.email, p.data_cadastro
    FROM sorteios s JOIN participantes p ON p.id = s.participante_id
    ORDER BY s.id`),
  clearDraws: db.prepare('DELETE FROM sorteios'),

  countUsers: db.prepare('SELECT COUNT(*) AS n FROM usuarios'),
  countActiveAdmins: db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE papel = 'admin' AND ativo = 1"),
  users: db.prepare(`SELECT ${USUARIO_COLS} FROM usuarios ORDER BY nome COLLATE NOCASE`),
  userById: db.prepare(`SELECT ${USUARIO_COLS} FROM usuarios WHERE id = ?`),
  userForLogin: db.prepare('SELECT id, nome, senha_hash, ativo FROM usuarios WHERE email = ?'),
  hashById: db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES (?, ?, ?, ?)'),
  updateUser: db.prepare('UPDATE usuarios SET nome = ?, email = ?, papel = ?, ativo = ? WHERE id = ?'),
  updatePassword: db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?'),
  deleteUser: db.prepare('DELETE FROM usuarios WHERE id = ?'),

  insertSession: db.prepare('INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES (?, ?, ?)'),
  session: db.prepare(`
    SELECT u.id, u.nome, u.email, u.papel FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.token_hash = ? AND s.expira_em > ? AND u.ativo = 1`),
  deleteSession: db.prepare('DELETE FROM sessoes WHERE token_hash = ?'),
  deleteSessionsOf: db.prepare('DELETE FROM sessoes WHERE usuario_id = ?'),
  deleteOtherSessions: db.prepare('DELETE FROM sessoes WHERE usuario_id = ? AND token_hash <> ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessoes WHERE expira_em <= ?'),

  insertLog: db.prepare('INSERT INTO auditoria (usuario_id, usuario_nome, acao, detalhe) VALUES (?, ?, ?, ?)'),
  logs: db.prepare('SELECT id, usuario_nome, acao, detalhe, criado_em FROM auditoria ORDER BY id DESC LIMIT 300'),
};

function registrar(usuario, acao, detalhe = null) {
  q.insertLog.run(usuario?.id ?? null, usuario?.nome ?? null, acao, detalhe);
}

function transacao(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- senhas e sessões ----------

const scrypt = promisify(crypto.scrypt);

async function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(senha, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function conferirSenha(senha, armazenado) {
  const [, salt, hash] = String(armazenado).split('$');
  if (!salt || !hash) return false;
  const esperado = Buffer.from(hash, 'base64');
  const calculado = await scrypt(senha, Buffer.from(salt, 'base64'), esperado.length);
  return crypto.timingSafeEqual(esperado, calculado);
}

// Hash descartável para gastar o mesmo tempo quando o e-mail não existe (não revela quem tem conta).
const HASH_FALSO = hashSenha(crypto.randomBytes(16).toString('hex'));

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function lerCookie(req, nome) {
  for (const parte of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) return decodeURIComponent(v.join('='));
  }
  return null;
}

function cookieSessao(req, token, maxAge) {
  const https = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${https ? '; Secure' : ''}`;
}

function criarSessao(req, usuarioId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.insertSession.run(sha256(token), usuarioId, Date.now() + SESSION_HOURS * 3600 * 1000);
  return { token, cookie: cookieSessao(req, token, SESSION_HOURS * 3600) };
}

function usuarioDaSessao(req) {
  const token = lerCookie(req, 'sid');
  if (!token) return null;
  const u = q.session.get(sha256(token), Date.now());
  return u ? { ...u, tokenHash: sha256(token) } : null;
}

setInterval(() => q.deleteExpiredSessions.run(Date.now()), 60 * 60 * 1000).unref();

async function criarPrimeiroAdmin() {
  if (q.countUsers.get().n > 0) return;
  if (!ADMIN_PASSWORD) {
    console.warn('[aviso] Nenhum usuário cadastrado. Defina ADMIN_PASSWORD (e ADMIN_EMAIL) para criar o primeiro administrador.');
    return;
  }
  q.insertUser.run('Administrador', ADMIN_EMAIL, await hashSenha(ADMIN_PASSWORD), 'admin');
  registrar(null, 'usuario.criado', `Primeiro administrador: ${ADMIN_EMAIL}`);
  console.log(`Primeiro administrador criado: ${ADMIN_EMAIL}`);
}

// ---------- utilitários HTTP ----------

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

function json(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

function redirect(res, location) {
  send(res, 302, '', { Location: location });
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

// Pedidos que alteram dados precisam vir do próprio site (barra ataques de CSRF). Um POST de outro
// site só chega sem preflight como formulário, então exigimos JSON; PUT e DELETE vindos de outro
// site sempre passam por preflight, que este servidor não autoriza.
function mesmaOrigem(req) {
  if (req.method === 'GET') return true;
  if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// Devolve o usuário logado, ou responde 401/403 e devolve null.
function exigirUsuario(req, res, papel = null) {
  const u = usuarioDaSessao(req);
  if (!u) {
    json(res, 401, { erro: 'Sua sessão expirou. Entre novamente.' });
    return null;
  }
  if (!mesmaOrigem(req)) {
    json(res, 403, { erro: 'Pedido recusado.' });
    return null;
  }
  if (papel === 'admin' && u.papel !== 'admin') {
    json(res, 403, { erro: 'Apenas administradores podem fazer isso.' });
    return null;
  }
  return u;
}

// Limite de tentativas por chave (IP ou e-mail) numa janela de tempo.
function criarLimitador(max, janelaMs) {
  const tentativas = new Map();
  setInterval(() => tentativas.clear(), Math.max(janelaMs, 60 * 60 * 1000)).unref();
  const recentes = (chave) => (tentativas.get(chave) || []).filter((t) => Date.now() - t < janelaMs);
  return {
    excedeu: (chave) => recentes(chave).length >= max,
    contar: (chave) => tentativas.set(chave, [...recentes(chave), Date.now()]),
  };
}
const limiteCadastro = criarLimitador(20, 10 * 60 * 1000);
// No login só contam as tentativas que falharam (a equipe costuma estar na mesma rede do evento).
const limiteLogin = criarLimitador(10, 15 * 60 * 1000);

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

const diaBr = (d) => d.split('-').reverse().join('/');

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

const emailValido = (email) => email.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

function normalize(body, { exigirAceite = true } = {}) {
  const nome = String(body.nome || '').trim().replace(/\s+/g, ' ');
  const cpf = String(body.cpf || '').replace(/\D/g, '');
  const telefone = String(body.telefone || '').replace(/\D/g, '');
  const email = String(body.email || '').trim().toLowerCase();
  const errors = [];
  if (nome.length < 3 || nome.length > 120) errors.push('Informe o nome completo.');
  if (!cpfValido(cpf)) errors.push('Informe um CPF válido.');
  if (telefone.length < 10 || telefone.length > 13) errors.push('Informe um telefone válido com DDD.');
  if (!emailValido(email)) errors.push('Informe um e-mail válido.');
  if (exigirAceite && body.aceite !== true) errors.push('É preciso aceitar os termos para participar.');
  return { nome, cpf, telefone, email, errors };
}

function normalizeUsuario(body, { senhaObrigatoria }) {
  const nome = String(body.nome || '').trim().replace(/\s+/g, ' ');
  const email = String(body.email || '').trim().toLowerCase();
  const papel = body.papel === 'admin' ? 'admin' : 'operador';
  const senha = String(body.senha || '');
  const errors = [];
  if (nome.length < 2 || nome.length > 80) errors.push('Informe o nome.');
  if (!emailValido(email)) errors.push('Informe um e-mail válido.');
  if ((senhaObrigatoria || senha) && senha.length < 8) errors.push('A senha precisa ter pelo menos 8 caracteres.');
  return { nome, email, papel, senha, ativo: body.ativo === false ? 0 : 1, errors };
}

const ehConflitoUnico = (e) => /UNIQUE constraint failed/.test(e.message || '');

// ---------- rotas ----------

const routes = [];
function rota(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '(\\d+)')) + '$');
  routes.push({ method, regex, keys, handler });
}

rota('GET', '/api/config', (req, res) => json(res, 200, { evento: EVENT_NAME, prefixo: CODE_PREFIX, hoje: hoje() }));

rota('POST', '/api/cadastro', async (req, res) => {
  limiteCadastro.contar(clientIp(req));
  if (limiteCadastro.excedeu(clientIp(req))) {
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
});

// --- login ---

rota('POST', '/api/login', async (req, res) => {
  if (!mesmaOrigem(req)) return json(res, 403, { erro: 'Pedido recusado.' });
  const body = await readJson(req).catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const senha = String(body.senha || '');
  const chaves = [clientIp(req), `email:${email}`];
  if (chaves.some(limiteLogin.excedeu)) {
    return json(res, 429, { erro: 'Muitas tentativas. Aguarde 15 minutos e tente de novo.' });
  }
  const u = q.userForLogin.get(email);
  const ok = await conferirSenha(senha, u ? u.senha_hash : await HASH_FALSO);
  if (!u || !ok) chaves.forEach(limiteLogin.contar);
  if (!u || !ok || !u.ativo) {
    if (u && ok && !u.ativo) return json(res, 403, { erro: 'Este usuário está desativado.' });
    return json(res, 401, { erro: 'E-mail ou senha incorretos.' });
  }
  const { cookie } = criarSessao(req, u.id);
  registrar(u, 'login');
  json(res, 200, { ok: true }, { 'Set-Cookie': cookie });
});

rota('POST', '/api/logout', (req, res) => {
  const u = usuarioDaSessao(req);
  if (u) q.deleteSession.run(u.tokenHash);
  json(res, 200, { ok: true }, { 'Set-Cookie': cookieSessao(req, '', 0) });
});

rota('GET', '/api/me', (req, res) => {
  const u = exigirUsuario(req, res);
  if (!u) return;
  json(res, 200, { id: u.id, nome: u.nome, email: u.email, papel: u.papel });
});

rota('POST', '/api/me/senha', async (req, res) => {
  const u = exigirUsuario(req, res);
  if (!u) return;
  const body = await readJson(req).catch(() => ({}));
  const nova = String(body.nova || '');
  if (!(await conferirSenha(String(body.atual || ''), q.hashById.get(u.id).senha_hash))) {
    return json(res, 422, { erro: 'A senha atual está incorreta.' });
  }
  if (nova.length < 8) return json(res, 422, { erro: 'A nova senha precisa ter pelo menos 8 caracteres.' });
  q.updatePassword.run(await hashSenha(nova), u.id);
  q.deleteOtherSessions.run(u.id, u.tokenHash);
  registrar(u, 'senha.alterada', 'Alterou a própria senha');
  json(res, 200, { ok: true });
});

// --- cadastros ---

rota('GET', '/api/admin/participantes', (req, res) => {
  if (!exigirUsuario(req, res)) return;
  json(res, 200, { participantes: q.all.all(), sorteios: q.draws.all(), datas: q.datas.all(), hoje: hoje() });
});

rota('GET', '/api/admin/participantes.csv', (req, res) => {
  if (!exigirUsuario(req, res)) return;
  const dia = dataParam(new URL(req.url, 'http://localhost').searchParams.get('data'));
  const rows = dia ? q.byDate.all(dia) : q.all.all();
  const lines = [['codigo', 'nome', 'cpf', 'telefone', 'email', 'data_cadastro', 'criado_em_utc'].join(',')];
  for (const r of rows) {
    lines.push([codigo(r.id), r.nome, r.cpf, r.telefone, r.email, r.data_cadastro, r.criado_em].map(csvCell).join(','));
  }
  send(res, 200, '﻿' + lines.join('\r\n'), {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="participantes${dia ? '-' + dia : ''}.csv"`,
  });
});

rota('PUT', '/api/admin/participantes/:id', async (req, res, { id }) => {
  const u = exigirUsuario(req, res);
  if (!u) return;
  const antes = q.byId.get(id);
  if (!antes) return json(res, 404, { erro: 'Cadastro não encontrado.' });
  const data = normalize(await readJson(req).catch(() => ({})), { exigirAceite: false });
  if (data.errors.length) return json(res, 422, { erro: data.errors.join(' ') });
  try {
    q.update.run(data.nome, data.cpf, data.telefone, data.email, id);
  } catch (e) {
    if (ehConflitoUnico(e)) return json(res, 409, { erro: 'Já existe outro cadastro com este CPF no mesmo dia.' });
    throw e;
  }
  const mudancas = ['nome', 'cpf', 'telefone', 'email']
    .filter((k) => antes[k] !== data[k])
    .map((k) => `${k}: "${antes[k] ?? ''}" → "${data[k]}"`);
  registrar(u, 'cadastro.editado', `${codigo(id)} · ${mudancas.join('; ') || 'sem mudanças'}`);
  json(res, 200, q.byId.get(id));
});

rota('DELETE', '/api/admin/participantes/:id', (req, res, { id }) => {
  const u = exigirUsuario(req, res, 'admin');
  if (!u) return;
  const p = q.byId.get(id);
  if (!p) return json(res, 404, { erro: 'Cadastro não encontrado.' });
  transacao(() => {
    q.deleteDrawsOf.run(id);
    q.delete.run(id);
  });
  registrar(u, 'cadastro.excluido', `${codigo(id)} · ${p.nome} · CPF ${p.cpf} · dia ${diaBr(p.data_cadastro)}`);
  json(res, 200, { ok: true });
});

// --- sorteio ---

rota('POST', '/api/admin/sortear', async (req, res) => {
  const u = exigirUsuario(req, res);
  if (!u) return;
  const body = await readJson(req).catch(() => ({}));
  // Com "data", só concorrem os cadastros feitos naquele dia (o dia do evento).
  const dia = dataParam(body.data);
  const pool = dia ? q.eligibleByDate.all(dia) : q.eligible.all();
  if (!pool.length) return json(res, 409, { erro: 'Não há participantes elegíveis para sortear.' });
  // crypto.randomInt usa um gerador criptograficamente seguro e sem viés.
  const winnerId = pool[crypto.randomInt(pool.length)].id;
  q.insertDraw.run(winnerId);
  const vencedor = q.byId.get(winnerId);
  registrar(u, 'sorteio', `${codigo(winnerId)} · ${vencedor.nome} · ${dia ? 'dia ' + diaBr(dia) : 'todas as datas'} · ${pool.length} concorrendo`);
  json(res, 200, { vencedor, elegiveis: pool.length });
});

rota('POST', '/api/admin/reiniciar-sorteios', (req, res) => {
  const u = exigirUsuario(req, res, 'admin');
  if (!u) return;
  q.clearDraws.run();
  registrar(u, 'sorteios.reiniciados', 'Apagou o histórico de sorteados');
  json(res, 200, { ok: true });
});

// --- usuários ---

rota('GET', '/api/admin/usuarios', (req, res) => {
  if (!exigirUsuario(req, res, 'admin')) return;
  json(res, 200, q.users.all());
});

rota('POST', '/api/admin/usuarios', async (req, res) => {
  const u = exigirUsuario(req, res, 'admin');
  if (!u) return;
  const d = normalizeUsuario(await readJson(req).catch(() => ({})), { senhaObrigatoria: true });
  if (d.errors.length) return json(res, 422, { erro: d.errors.join(' ') });
  try {
    const r = q.insertUser.run(d.nome, d.email, await hashSenha(d.senha), d.papel);
    registrar(u, 'usuario.criado', `${d.nome} <${d.email}> como ${d.papel}`);
    json(res, 201, q.userById.get(Number(r.lastInsertRowid)));
  } catch (e) {
    if (ehConflitoUnico(e)) return json(res, 409, { erro: 'Já existe um usuário com este e-mail.' });
    throw e;
  }
});

rota('PUT', '/api/admin/usuarios/:id', async (req, res, { id }) => {
  const u = exigirUsuario(req, res, 'admin');
  if (!u) return;
  const alvo = q.userById.get(id);
  if (!alvo) return json(res, 404, { erro: 'Usuário não encontrado.' });
  const d = normalizeUsuario(await readJson(req).catch(() => ({})), { senhaObrigatoria: false });
  if (d.errors.length) return json(res, 422, { erro: d.errors.join(' ') });
  const deixaDeSerAdminAtivo = alvo.papel === 'admin' && alvo.ativo && (d.papel !== 'admin' || !d.ativo);
  if (deixaDeSerAdminAtivo && q.countActiveAdmins.get().n <= 1) {
    return json(res, 409, { erro: 'É preciso manter pelo menos um administrador ativo.' });
  }
  const novoHash = d.senha ? await hashSenha(d.senha) : null;
  try {
    transacao(() => {
      q.updateUser.run(d.nome, d.email, d.papel, d.ativo, id);
      if (novoHash) q.updatePassword.run(novoHash, id);
      // Desativar ou trocar a senha derruba as sessões abertas desse usuário.
      if (novoHash || !d.ativo) q.deleteSessionsOf.run(id);
    });
  } catch (e) {
    if (ehConflitoUnico(e)) return json(res, 409, { erro: 'Já existe um usuário com este e-mail.' });
    throw e;
  }
  const mudancas = [];
  if (alvo.nome !== d.nome) mudancas.push(`nome: "${alvo.nome}" → "${d.nome}"`);
  if (alvo.email !== d.email) mudancas.push(`e-mail: ${alvo.email} → ${d.email}`);
  if (alvo.papel !== d.papel) mudancas.push(`perfil: ${alvo.papel} → ${d.papel}`);
  if (alvo.ativo !== d.ativo) mudancas.push(d.ativo ? 'reativado' : 'desativado');
  if (novoHash) mudancas.push('senha redefinida');
  registrar(u, 'usuario.editado', `${d.nome} · ${mudancas.join('; ') || 'sem mudanças'}`);
  json(res, 200, q.userById.get(id));
});

rota('DELETE', '/api/admin/usuarios/:id', (req, res, { id }) => {
  const u = exigirUsuario(req, res, 'admin');
  if (!u) return;
  const alvo = q.userById.get(id);
  if (!alvo) return json(res, 404, { erro: 'Usuário não encontrado.' });
  if (alvo.id === u.id) return json(res, 409, { erro: 'Você não pode excluir o próprio usuário.' });
  if (alvo.papel === 'admin' && alvo.ativo && q.countActiveAdmins.get().n <= 1) {
    return json(res, 409, { erro: 'É preciso manter pelo menos um administrador ativo.' });
  }
  q.deleteUser.run(id);
  registrar(u, 'usuario.excluido', `${alvo.nome} <${alvo.email}>`);
  json(res, 200, { ok: true });
});

rota('GET', '/api/admin/auditoria', (req, res) => {
  if (!exigirUsuario(req, res, 'admin')) return;
  json(res, 200, q.logs.all());
});

// --- páginas ---

rota('GET', '/login', (req, res) => {
  if (usuarioDaSessao(req)) return redirect(res, '/admin');
  serveFile(res, 'login.html');
});

rota('GET', '/admin', (req, res) => {
  if (!usuarioDaSessao(req)) return redirect(res, '/login');
  serveFile(res, 'admin.html');
});

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
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.regex);
      if (m) return await r.handler(req, res, Object.fromEntries(r.keys.map((k, i) => [k, Number(m[i + 1])])));
    }
    if (req.method !== 'GET') return send(res, 405, 'Método não permitido');
    if (pathname === '/' || pathname === '/index.html') return serveFile(res, 'index.html');
    if (pathname === '/admin.html') return redirect(res, '/admin');
    if (pathname === '/login.html') return redirect(res, '/login');
    return serveFile(res, decodeURIComponent(pathname).replace(/^\/+/, ''));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { erro: 'Erro interno. Tente novamente.' });
  }
});

criarPrimeiroAdmin().then(() => {
  server.listen(PORT, () => {
    console.log(`Sorteio "${EVENT_NAME}" rodando em http://localhost:${PORT}`);
    console.log(`Painel: http://localhost:${PORT}/admin`);
  });
});
