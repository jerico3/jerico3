'use strict';

// Servidor sem dependências externas: usa apenas módulos nativos do Node (>= 22.13).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const totp = require('./totp');
const mailer = require('./mailer');

const PORT = Number(process.env.PORT) || 3000;
// Usados só para criar o primeiro administrador, quando ainda não existe nenhum usuário.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@sorteio.local').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const EVENT_NAME = process.env.EVENT_NAME || 'Sorteio';
// Endereço público usado para montar os links e QR Codes no painel (ex.: https://importadoravw.link).
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const CODE_PREFIX = process.env.CODE_PREFIX ?? 'VW-';
// Fuso usado para definir o "dia do cadastro" (cada evento sorteia só entre os cadastros do seu dia).
const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'sorteio.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_HOURS = 12;
// Nome que aparece no app autenticador (Google Authenticator etc.) ao lado do e-mail.
const TOTP_EMISSOR = process.env.TOTP_EMISSOR || 'Importadora Link';
// Dados do controlador exibidos no Aviso de Privacidade (/privacidade).
const CONTROLADOR_NOME = process.env.CONTROLADOR_NOME || EVENT_NAME;
const CONTROLADOR_CNPJ = process.env.CONTROLADOR_CNPJ || '';
const CONTATO_PRIVACIDADE = process.env.CONTATO_PRIVACIDADE || '';
// Cadastros com mais de N dias são apagados automaticamente (0 = não apaga).
const RETENCAO_DIAS = Math.max(0, Number(process.env.RETENCAO_DIAS) || 0);
// Versão do texto do aviso/termo. Mude quando o texto mudar: cada cadastro guarda a versão aceita.
const TERMOS_VERSAO = '2026-10-18';

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
// Prova do consentimento (LGPD, art. 8º): quando aceitou, qual versão do aviso, e se aceitou ofertas.
for (const [col, tipo] of [['aceite_em', 'TEXT'], ['termos_versao', 'TEXT'], ['aceita_marketing', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!db.prepare('PRAGMA table_info(participantes)').all().some((c) => c.name === col)) {
    db.exec(`ALTER TABLE participantes ADD COLUMN ${col} ${tipo}`);
  }
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
  -- Links "coringa": o QR Code impresso aponta para o link, e o destino pode mudar a qualquer momento.
  -- O link de endereço vazio é o principal (a raiz do site).
  CREATE TABLE IF NOT EXISTS links (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    slug           TEXT NOT NULL UNIQUE,
    destino        TEXT NOT NULL,
    descricao      TEXT,
    cliques        INTEGER NOT NULL DEFAULT 0,
    atualizado_em  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO links (slug, destino, descricao) VALUES ('', '/sorteio', 'Link principal (QR Code impresso)');
  -- Um registro por acesso a um link, para os relatórios. Não guarda IP nem nada que identifique a pessoa.
  CREATE TABLE IF NOT EXISTS acessos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id      INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    dia          TEXT NOT NULL,
    hora         INTEGER NOT NULL,
    dispositivo  TEXT NOT NULL,
    criado_em    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS acessos_link_dia ON acessos (link_id, dia);
`);
if (!db.prepare('PRAGMA table_info(links)').all().some((c) => c.name === 'utm')) {
  db.exec('ALTER TABLE links ADD COLUMN utm INTEGER NOT NULL DEFAULT 1');
}
// Convite por e-mail (confirmado = 0 até a pessoa definir a senha) e verificação em duas etapas.
for (const [col, tipo] of [
  ['confirmado', 'INTEGER NOT NULL DEFAULT 1'],
  ['totp_segredo', 'TEXT'],
  ['totp_ativo', 'INTEGER NOT NULL DEFAULT 0'],
  ['totp_ultimo_passo', 'INTEGER NOT NULL DEFAULT -1'],
  ['codigos_recuperacao', 'TEXT'],
  // Chave gerada no primeiro login e guardada até ser confirmada: o QR Code não muda entre tentativas.
  ['totp_pendente', 'TEXT'],
]) {
  if (!db.prepare('PRAGMA table_info(usuarios)').all().some((c) => c.name === col)) {
    db.exec(`ALTER TABLE usuarios ADD COLUMN ${col} ${tipo}`);
  }
}
db.exec(`
  -- Links de uso único enviados por e-mail (convite e recuperação de senha). Só o hash fica salvo.
  CREATE TABLE IF NOT EXISTS tokens_email (
    token_hash  TEXT PRIMARY KEY,
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    tipo        TEXT NOT NULL CHECK (tipo IN ('convite', 'reset')),
    expira_em   INTEGER NOT NULL,
    usado_em    INTEGER
  );
  -- Etapa intermediária do login (senha conferida, falta o código do app). No banco, e não na
  -- memória, para funcionar mesmo se o servidor reiniciar ou rodar em mais de um processo.
  CREATE TABLE IF NOT EXISTS login_tickets (
    token_hash  TEXT PRIMARY KEY,
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira_em   INTEGER NOT NULL,
    tentativas  INTEGER NOT NULL DEFAULT 0
  );
`);

const PARTICIPANTE_COLS = 'id, nome, cpf, telefone, email, data_cadastro, criado_em, aceite_em, termos_versao, aceita_marketing';
const USUARIO_COLS = 'id, nome, email, papel, ativo, criado_em, confirmado, totp_ativo';

const q = {
  insert: db.prepare(`
    INSERT INTO participantes (nome, cpf, telefone, email, data_cadastro, aceite_em, termos_versao, aceita_marketing)
    VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?)`),
  byCpfDia: db.prepare('SELECT id, nome, telefone FROM participantes WHERE cpf = ? AND data_cadastro = ?'),
  expiredIds: db.prepare('SELECT id FROM participantes WHERE data_cadastro < ?'),
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
  userForLogin: db.prepare('SELECT id, nome, senha_hash, ativo, confirmado, totp_ativo FROM usuarios WHERE email = ?'),
  userAuth: db.prepare(`
    SELECT id, nome, email, papel, ativo, confirmado, totp_segredo, totp_ativo, totp_ultimo_passo, codigos_recuperacao, totp_pendente
    FROM usuarios WHERE id = ?`),
  totpPendente: db.prepare('UPDATE usuarios SET totp_pendente = ? WHERE id = ? AND totp_pendente IS NULL'),
  insertTicket: db.prepare('INSERT INTO login_tickets (token_hash, usuario_id, expira_em) VALUES (?, ?, ?)'),
  ticket: db.prepare('SELECT usuario_id, tentativas FROM login_tickets WHERE token_hash = ? AND expira_em > ?'),
  tentativaTicket: db.prepare('UPDATE login_tickets SET tentativas = tentativas + 1 WHERE token_hash = ?'),
  deleteTicket: db.prepare('DELETE FROM login_tickets WHERE token_hash = ?'),
  ticketsVencidos: db.prepare('DELETE FROM login_tickets WHERE expira_em <= ?'),
  userByEmail: db.prepare('SELECT id, nome, email, ativo, confirmado FROM usuarios WHERE email = ?'),
  insertUserPendente: db.prepare('INSERT INTO usuarios (nome, email, senha_hash, papel, confirmado) VALUES (?, ?, ?, ?, 0)'),
  confirmarUsuario: db.prepare('UPDATE usuarios SET senha_hash = ?, confirmado = 1 WHERE id = ?'),
  ativarTotp: db.prepare('UPDATE usuarios SET totp_segredo = ?, totp_ativo = 1, totp_ultimo_passo = ?, codigos_recuperacao = ?, totp_pendente = NULL WHERE id = ?'),
  passoTotp: db.prepare('UPDATE usuarios SET totp_ultimo_passo = ? WHERE id = ?'),
  codigosRecuperacao: db.prepare('UPDATE usuarios SET codigos_recuperacao = ? WHERE id = ?'),
  zerarTotp: db.prepare('UPDATE usuarios SET totp_segredo = NULL, totp_ativo = 0, totp_ultimo_passo = -1, codigos_recuperacao = NULL, totp_pendente = NULL WHERE id = ?'),
  insertToken: db.prepare('INSERT INTO tokens_email (token_hash, usuario_id, tipo, expira_em) VALUES (?, ?, ?, ?)'),
  token: db.prepare(`
    SELECT t.usuario_id, t.tipo, u.nome, u.email FROM tokens_email t JOIN usuarios u ON u.id = t.usuario_id
    WHERE t.token_hash = ? AND t.usado_em IS NULL AND t.expira_em > ? AND u.ativo = 1`),
  usarToken: db.prepare('UPDATE tokens_email SET usado_em = ? WHERE token_hash = ?'),
  descartarTokens: db.prepare('DELETE FROM tokens_email WHERE usuario_id = ? AND tipo = ? AND usado_em IS NULL'),
  tokensVencidos: db.prepare('DELETE FROM tokens_email WHERE expira_em <= ?'),
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

  links: db.prepare('SELECT id, slug, destino, descricao, utm, cliques, atualizado_em FROM links ORDER BY slug <> \'\', slug'),
  linkById: db.prepare('SELECT id, slug, destino, descricao, utm, cliques, atualizado_em FROM links WHERE id = ?'),
  linkBySlug: db.prepare('SELECT id, slug, destino, utm FROM links WHERE slug = ?'),
  insertLink: db.prepare('INSERT INTO links (slug, destino, descricao, utm) VALUES (?, ?, ?, ?)'),
  updateLink: db.prepare("UPDATE links SET slug = ?, destino = ?, descricao = ?, utm = ?, atualizado_em = datetime('now') WHERE id = ?"),
  insertAcesso: db.prepare('INSERT INTO acessos (link_id, dia, hora, dispositivo) VALUES (?, ?, ?, ?)'),
  acessosPorDia: db.prepare('SELECT dia, COUNT(*) AS total FROM acessos WHERE link_id = ? AND dia >= ? GROUP BY dia'),
  acessosPorDispositivo: db.prepare(`
    SELECT dispositivo, COUNT(*) AS total FROM acessos WHERE link_id = ? AND dia >= ?
    GROUP BY dispositivo ORDER BY total DESC`),
  acessosPorHora: db.prepare('SELECT hora, COUNT(*) AS total FROM acessos WHERE link_id = ? AND dia >= ? GROUP BY hora'),
  deleteLink: db.prepare('DELETE FROM links WHERE id = ?'),
  countClick: db.prepare('UPDATE links SET cliques = cliques + 1 WHERE id = ?'),
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
    if (k === nome) {
      try {
        return decodeURIComponent(v.join('='));
      } catch {
        return null;
      }
    }
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
  if (ADMIN_PASSWORD.length < 8) {
    console.warn('[aviso] ADMIN_PASSWORD tem menos de 8 caracteres. Troque a senha no painel assim que entrar.');
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

// Atrás de um proxy (Hostinger, Caddy), o último valor de X-Forwarded-For é o IP que o proxy viu;
// os anteriores vêm do próprio cliente e poderiam ser forjados para escapar do limite de tentativas.
function clientIp(req) {
  const ips = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return ips[ips.length - 1] || req.socket.remoteAddress;
}

// Operadores veem o CPF mascarado (minimização de dados): ***.456.789-**
function mascararCpf(cpf) {
  return cpf ? `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**` : cpf;
}
function paraUsuario(u, p) {
  return u.papel === 'admin' || !p ? p : { ...p, cpf: mascararCpf(p.cpf) };
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  // Evita injeção de fórmulas ao abrir o CSV no Excel/Sheets.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

// "AAAA-MM-DD" no fuso configurado.
const formatoDia = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const formatoHora = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: 'numeric', hourCycle: 'h23' });
function hoje(data = new Date()) {
  return formatoDia.format(data);
}
function horaLocal(data = new Date()) {
  return Number(formatoHora.format(data));
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
  if (exigirAceite && body.aceite !== true) errors.push('É preciso aceitar o Aviso de Privacidade para participar.');
  return { nome, cpf, telefone, email, marketing: body.marketing === true ? 1 : 0, errors };
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

// ---------- e-mails, links de uso único e verificação em duas etapas ----------

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// E-mail simples, com versão texto e HTML (estilos inline, que é o que os leitores de e-mail aceitam).
function montarEmail({ titulo, paragrafos, botao, link, rodape }) {
  const texto = [titulo, '', ...paragrafos, ...(link ? ['', `${botao}: ${link}`] : []), '', rodape || ''].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f6fa;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:#011250;color:#fff;padding:18px 24px;font-size:16px;font-weight:bold">${escHtml(EVENT_NAME)} · Painel do sorteio</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 12px;font-size:20px;color:#011250">${escHtml(titulo)}</h1>
${paragrafos.map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${escHtml(p)}</p>`).join('')}
${link ? `<p style="margin:20px 0"><a href="${escHtml(link)}" style="display:inline-block;background:#0a1a80;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px">${escHtml(botao)}</a></p>
<p style="margin:0;font-size:12px;color:#64748b;word-break:break-all">Se o botão não funcionar, copie e cole no navegador:<br>${escHtml(link)}</p>` : ''}
${rodape ? `<p style="margin:20px 0 0;font-size:12px;color:#64748b">${escHtml(rodape)}</p>` : ''}
</td></tr></table></td></tr></table></body></html>`;
  return { texto, html };
}

async function enviarEmail(para, assunto, conteudo) {
  await mailer.enviar({ para, assunto, ...montarEmail(conteudo) });
}

// Endereço usado nos links dos e-mails. Preferimos PUBLIC_URL: montar o link a partir do cabeçalho
// Host de um pedido anônimo permitiria a alguém mandar à vítima um link para outro site.
function urlBase(req, { confiarNoHost = false } = {}) {
  if (PUBLIC_URL) return PUBLIC_URL;
  if (!confiarNoHost) return null;
  const proto = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${req.headers.host}`;
}

const VALIDADE = { convite: 72 * 3600 * 1000, reset: 3600 * 1000 };

function criarToken(usuarioId, tipo) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.descartarTokens.run(usuarioId, tipo);
  q.insertToken.run(sha256(token), usuarioId, tipo, Date.now() + VALIDADE[tipo]);
  return token;
}
setInterval(() => q.tokensVencidos.run(Date.now() - 24 * 3600 * 1000), 60 * 60 * 1000).unref();

// Gera o convite e tenta mandar por e-mail. Sem e-mail configurado, devolve o link para o
// administrador repassar por outro meio.
async function enviarConvite(req, alvo, quemConvidou) {
  const link = `${urlBase(req, { confiarNoHost: true })}/definir-senha#t=${criarToken(alvo.id, 'convite')}`;
  if (!mailer.configurado()) return { enviado: false, link, motivo: 'O envio de e-mails não está configurado.' };
  try {
    await enviarEmail(alvo.email, `Confirme seu acesso ao painel do sorteio — ${EVENT_NAME}`, {
      titulo: `Olá, ${alvo.nome.split(' ')[0]}!`,
      paragrafos: [
        `${quemConvidou.nome} criou um acesso para você no painel do sorteio da ${EVENT_NAME}.`,
        'Para confirmar o cadastro, clique no botão abaixo e crie a sua senha. Depois, no primeiro login, você vai configurar a verificação em duas etapas com um app autenticador no celular.',
        'O link vale por 72 horas e só pode ser usado uma vez.',
      ],
      botao: 'Confirmar cadastro e criar senha',
      link,
      rodape: 'Se você não esperava este e-mail, pode ignorá-lo.',
    });
    return { enviado: true };
  } catch (e) {
    console.error('Falha ao enviar convite:', e.message);
    return { enviado: false, link, motivo: `Não foi possível enviar o e-mail (${e.message}).` };
  }
}

function avisarSenhaAlterada(usuario) {
  if (!mailer.configurado()) return;
  enviarEmail(usuario.email, `Sua senha do painel foi alterada — ${EVENT_NAME}`, {
    titulo: 'Sua senha foi alterada',
    paragrafos: [
      `A senha do seu acesso ao painel do sorteio (${usuario.email}) acabou de ser alterada.`,
      'Se foi você, não precisa fazer nada. Se não foi, fale imediatamente com um administrador.',
    ],
  }).catch((e) => console.error('Falha ao enviar aviso de senha:', e.message));
}

// Etapa intermediária do login: a senha já conferiu, falta o código do app. Vale 15 minutos,
// com no máximo 5 tentativas de código.
function criarTicket(usuarioId) {
  const ticket = crypto.randomBytes(24).toString('base64url');
  q.insertTicket.run(sha256(ticket), usuarioId, Date.now() + 15 * 60 * 1000);
  return ticket;
}
function lerTicket(ticket) {
  const chave = sha256(String(ticket || ''));
  const t = q.ticket.get(chave, Date.now());
  return t ? { chave, usuarioId: t.usuario_id, tentativas: t.tentativas } : null;
}
setInterval(() => q.ticketsVencidos.run(Date.now()), 10 * 60 * 1000).unref();

function dicaRelogio(segredo, codigo) {
  const min = totp.desvioMinutos(segredo, codigo);
  if (min === null) return '';
  return ` O horário do seu celular parece estar ${Math.abs(min)} min ${min > 0 ? 'adiantado' : 'atrasado'}: ative "data e hora automáticas" nas configurações do celular.`;
}

const normalizarRecuperacao = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function gerarCodigosRecuperacao() {
  return Array.from({ length: 10 }, () => {
    const c = totp.base32(crypto.randomBytes(5)).toLowerCase();
    return `${c.slice(0, 4)}-${c.slice(4, 8)}`;
  });
}

const limiteEmail = criarLimitador(5, 60 * 60 * 1000);

// ---------- rotas ----------

const routes = [];
function rota(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '(\\d+)')) + '$');
  routes.push({ method, regex, keys, handler });
}

rota('GET', '/api/config', (req, res) => json(res, 200, {
  evento: EVENT_NAME,
  prefixo: CODE_PREFIX,
  hoje: hoje(),
  publicUrl: PUBLIC_URL,
  privacidade: {
    controlador: CONTROLADOR_NOME,
    cnpj: CONTROLADOR_CNPJ,
    contato: CONTATO_PRIVACIDADE,
    retencaoDias: RETENCAO_DIAS,
    versao: TERMOS_VERSAO,
  },
}));

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
    // Só devolve o código se o telefone conferir: sem isso, qualquer um que digitasse o CPF de
    // outra pessoa descobriria o nome e o código dela.
    if (existing.telefone !== data.telefone) {
      return json(res, 409, { erro: 'Este CPF já foi cadastrado hoje. Se foi você, informe o mesmo telefone usado no cadastro.' });
    }
    return json(res, 200, { id: existing.id, nome: existing.nome, data_cadastro: dia, jaCadastrado: true });
  }
  const r = q.insert.run(data.nome, data.cpf, data.telefone, data.email, dia, TERMOS_VERSAO, data.marketing);
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
  if (!u || !ok || !u.ativo || !u.confirmado) {
    if (u && ok && !u.ativo) return json(res, 403, { erro: 'Este usuário está desativado.' });
    return json(res, 401, { erro: 'E-mail ou senha incorretos.' });
  }
  // Senha certa: falta a segunda etapa (código do app). Quem ainda não configurou, configura agora.
  json(res, 200, { etapa: u.totp_ativo ? 'codigo' : 'configurar', ticket: criarTicket(u.id) });
});

rota('POST', '/api/login/configurar', async (req, res) => {
  if (!mesmaOrigem(req)) return json(res, 403, { erro: 'Pedido recusado.' });
  const body = await readJson(req).catch(() => ({}));
  const tk = lerTicket(body.ticket);
  if (!tk) return json(res, 401, { erro: 'Sua tentativa de login expirou. Entre de novo.' });
  const usuario = q.userAuth.get(tk.usuarioId);
  if (!usuario || usuario.totp_ativo) return json(res, 409, { erro: 'A verificação em duas etapas já está configurada.' });
  // A mesma chave vale até ser confirmada; assim, sair e voltar não invalida o que já foi lido no app.
  q.totpPendente.run(totp.gerarSegredo(), usuario.id);
  const segredo = q.userAuth.get(usuario.id).totp_pendente;
  json(res, 200, { segredo, uri: totp.uri(segredo, usuario.email, TOTP_EMISSOR), emissor: TOTP_EMISSOR });
});

rota('POST', '/api/login/verificar', async (req, res) => {
  if (!mesmaOrigem(req)) return json(res, 403, { erro: 'Pedido recusado.' });
  const body = await readJson(req).catch(() => ({}));
  const ip = clientIp(req);
  if (limiteLogin.excedeu(ip)) return json(res, 429, { erro: 'Muitas tentativas. Aguarde 15 minutos e tente de novo.' });
  const tk = lerTicket(body.ticket);
  if (!tk) return json(res, 401, { erro: 'Sua tentativa de login expirou. Entre de novo.' });
  const usuario = q.userAuth.get(tk.usuarioId);
  if (!usuario || !usuario.ativo) return json(res, 401, { erro: 'Sua tentativa de login expirou. Entre de novo.' });
  q.tentativaTicket.run(tk.chave);
  if (tk.tentativas + 1 > 5) {
    q.deleteTicket.run(tk.chave);
    return json(res, 429, { erro: 'Muitas tentativas. Entre de novo com sua senha.' });
  }

  let codigosNovos = null;
  let detalhe = null;
  if (usuario.totp_ativo) {
    const passo = totp.verificar(usuario.totp_segredo, body.codigo, usuario.totp_ultimo_passo);
    if (passo !== null) {
      q.passoTotp.run(passo, usuario.id);
    } else {
      // Código de recuperação (uso único), para quem perdeu o celular.
      const lista = JSON.parse(usuario.codigos_recuperacao || '[]');
      const i = lista.indexOf(sha256(normalizarRecuperacao(body.codigo)));
      if (i < 0 || normalizarRecuperacao(body.codigo).length !== 8) {
        limiteLogin.contar(ip);
        return json(res, 401, { erro: `Código incorreto. Use o código da conta "${TOTP_EMISSOR}" no app.${dicaRelogio(usuario.totp_segredo, body.codigo)}` });
      }
      lista.splice(i, 1);
      q.codigosRecuperacao.run(JSON.stringify(lista), usuario.id);
      detalhe = `Usou um código de recuperação (restam ${lista.length})`;
    }
  } else {
    const segredo = usuario.totp_pendente;
    if (!segredo) return json(res, 409, { erro: 'Leia o QR Code no app antes de digitar o código.' });
    const passo = totp.verificar(segredo, body.codigo);
    if (passo === null) {
      limiteLogin.contar(ip);
      return json(res, 401, { erro: `Código incorreto. Confira se está usando a conta "${TOTP_EMISSOR}" lida neste QR Code (apague do app as entradas antigas).${dicaRelogio(segredo, body.codigo)}` });
    }
    codigosNovos = gerarCodigosRecuperacao();
    q.ativarTotp.run(segredo, passo, JSON.stringify(codigosNovos.map((c) => sha256(normalizarRecuperacao(c)))), usuario.id);
    registrar(usuario, '2fa.ativado', 'Configurou a verificação em duas etapas');
  }
  q.deleteTicket.run(tk.chave);
  const { cookie } = criarSessao(req, usuario.id);
  registrar(usuario, 'login', detalhe);
  json(res, 200, { ok: true, codigosRecuperacao: codigosNovos }, { 'Set-Cookie': cookie });
});

// --- senha: convite e recuperação por e-mail ---

rota('POST', '/api/senha/esqueci', async (req, res) => {
  if (!mesmaOrigem(req)) return json(res, 403, { erro: 'Pedido recusado.' });
  const body = await readJson(req).catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const resposta = { ok: true, mensagem: 'Se este e-mail estiver cadastrado, você vai receber um link para criar uma nova senha em alguns minutos.' };
  if (!mailer.configurado() || !PUBLIC_URL) {
    return json(res, 503, { erro: 'A recuperação por e-mail ainda não está configurada. Peça a um administrador para reenviar seu acesso.' });
  }
  const chaves = [clientIp(req), `email:${email}`];
  if (chaves.some(limiteEmail.excedeu)) return json(res, 429, { erro: 'Muitos pedidos. Aguarde uma hora e tente de novo.' });
  chaves.forEach(limiteEmail.contar);
  const u = q.userByEmail.get(email);
  // A resposta é sempre a mesma: não revela se o e-mail tem acesso ou não.
  if (u && u.ativo) {
    const tipo = u.confirmado ? 'reset' : 'convite';
    const link = `${PUBLIC_URL}/definir-senha#t=${criarToken(u.id, tipo)}`;
    enviarEmail(u.email, `Criar nova senha do painel — ${EVENT_NAME}`, {
      titulo: 'Criar uma nova senha',
      paragrafos: [
        `Recebemos um pedido para criar uma nova senha para ${u.email} no painel do sorteio.`,
        'Clique no botão abaixo para escolher a nova senha. O link vale por 1 hora e só pode ser usado uma vez.',
        'A verificação em duas etapas continua valendo: depois da nova senha, você ainda vai precisar do código do app.',
      ],
      botao: 'Criar nova senha',
      link,
      rodape: 'Se você não pediu isso, ignore este e-mail: sua senha atual continua valendo.',
    }).then(() => registrar(u, 'senha.recuperacao', 'Pediu link de recuperação por e-mail'))
      .catch((e) => console.error('Falha ao enviar recuperação de senha:', e.message));
  }
  json(res, 200, resposta);
});

rota('POST', '/api/senha/verificar', async (req, res) => {
  if (!mesmaOrigem(req)) return json(res, 403, { erro: 'Pedido recusado.' });
  const body = await readJson(req).catch(() => ({}));
  const t = q.token.get(sha256(String(body.token || '')), Date.now());
  if (!t) return json(res, 410, { erro: 'Este link expirou ou já foi usado. Peça um novo.' });
  json(res, 200, { nome: t.nome, email: t.email, tipo: t.tipo });
});

rota('POST', '/api/senha/definir', async (req, res) => {
  if (!mesmaOrigem(req)) return json(res, 403, { erro: 'Pedido recusado.' });
  const body = await readJson(req).catch(() => ({}));
  const hash = sha256(String(body.token || ''));
  const t = q.token.get(hash, Date.now());
  if (!t) return json(res, 410, { erro: 'Este link expirou ou já foi usado. Peça um novo.' });
  const senha = String(body.senha || '');
  if (senha.length < 8) return json(res, 422, { erro: 'A senha precisa ter pelo menos 8 caracteres.' });
  if (senha.toLowerCase() === t.email) return json(res, 422, { erro: 'A senha não pode ser igual ao e-mail.' });
  const novoHash = await hashSenha(senha);
  transacao(() => {
    q.usarToken.run(Date.now(), hash);
    q.confirmarUsuario.run(novoHash, t.usuario_id);
    q.deleteSessionsOf.run(t.usuario_id);
  });
  const usuario = { id: t.usuario_id, nome: t.nome, email: t.email };
  if (t.tipo === 'convite') {
    registrar(usuario, 'convite.aceito', 'Confirmou o cadastro e criou a senha');
  } else {
    registrar(usuario, 'senha.redefinida', 'Criou nova senha pelo link do e-mail');
    avisarSenhaAlterada(usuario);
  }
  json(res, 200, { ok: true });
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
  avisarSenhaAlterada(u);
  json(res, 200, { ok: true });
});

// --- cadastros ---

rota('GET', '/api/admin/participantes', (req, res) => {
  const u = exigirUsuario(req, res);
  if (!u) return;
  json(res, 200, {
    participantes: q.all.all().map((p) => paraUsuario(u, p)),
    sorteios: q.draws.all().map((p) => paraUsuario(u, p)),
    datas: q.datas.all(),
    hoje: hoje(),
  });
});

rota('GET', '/api/admin/participantes.csv', (req, res) => {
  const u = exigirUsuario(req, res, 'admin');
  if (!u) return;
  const dia = dataParam(new URL(req.url, 'http://localhost').searchParams.get('data'));
  const rows = dia ? q.byDate.all(dia) : q.all.all();
  const lines = [['codigo', 'nome', 'cpf', 'telefone', 'email', 'data_cadastro', 'criado_em_utc', 'aceita_ofertas', 'aceite_em_utc', 'versao_aviso'].join(',')];
  for (const r of rows) {
    lines.push([codigo(r.id), r.nome, r.cpf, r.telefone, r.email, r.data_cadastro, r.criado_em,
      r.aceita_marketing ? 'sim' : 'nao', r.aceite_em, r.termos_versao].map(csvCell).join(','));
  }
  registrar(u, 'cadastros.exportados', `${rows.length} cadastros · ${dia ? 'dia ' + diaBr(dia) : 'todas as datas'}`);
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
  const body = await readJson(req).catch(() => ({}));
  // Operadores veem o CPF mascarado e não podem alterá-lo.
  if (u.papel !== 'admin') body.cpf = antes.cpf;
  const data = normalize(body, { exigirAceite: false });
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
  json(res, 200, paraUsuario(u, q.byId.get(id)));
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
  json(res, 200, { vencedor: paraUsuario(u, vencedor), elegiveis: pool.length });
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
  // A senha é criada pela própria pessoa, pelo link do convite. Até lá a conta fica pendente.
  const d = normalizeUsuario({ ...(await readJson(req).catch(() => ({}))), senha: '' }, { senhaObrigatoria: false });
  if (d.errors.length) return json(res, 422, { erro: d.errors.join(' ') });
  let novo;
  try {
    const r = q.insertUserPendente.run(d.nome, d.email, await hashSenha(crypto.randomBytes(32).toString('hex')), d.papel);
    novo = q.userById.get(Number(r.lastInsertRowid));
  } catch (e) {
    if (ehConflitoUnico(e)) return json(res, 409, { erro: 'Já existe um usuário com este e-mail.' });
    throw e;
  }
  const convite = await enviarConvite(req, novo, u);
  registrar(u, 'usuario.criado', `${d.nome} <${d.email}> como ${d.papel} · convite ${convite.enviado ? 'enviado por e-mail' : 'gerado para envio manual'}`);
  json(res, 201, { ...novo, convite });
});

rota('POST', '/api/admin/usuarios/:id/convite', async (req, res, { id }) => {
  const u = exigirUsuario(req, res, 'admin');
  if (!u) return;
  const alvo = q.userById.get(id);
  if (!alvo) return json(res, 404, { erro: 'Usuário não encontrado.' });
  if (alvo.confirmado) return json(res, 409, { erro: 'Este usuário já confirmou o cadastro. Para trocar a senha, ele pode usar "Esqueci minha senha".' });
  const convite = await enviarConvite(req, alvo, u);
  registrar(u, 'convite.reenviado', `${alvo.nome} <${alvo.email}> · ${convite.enviado ? 'por e-mail' : 'link para envio manual'}`);
  json(res, 200, { convite });
});

rota('POST', '/api/admin/usuarios/:id/redefinir-2fa', (req, res, { id }) => {
  const u = exigirUsuario(req, res, 'admin');
  if (!u) return;
  const alvo = q.userById.get(id);
  if (!alvo) return json(res, 404, { erro: 'Usuário não encontrado.' });
  transacao(() => {
    q.zerarTotp.run(id);
    q.deleteSessionsOf.run(id);
  });
  registrar(u, '2fa.redefinido', `${alvo.nome} <${alvo.email}> vai configurar o app de novo no próximo login`);
  json(res, 200, { ok: true });
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
  // Senhas não são mais definidas pelo administrador: cada pessoa cria a sua pelo link do e-mail.
  try {
    transacao(() => {
      q.updateUser.run(d.nome, d.email, d.papel, d.ativo, id);
      // Desativar derruba as sessões abertas desse usuário.
      if (!d.ativo) q.deleteSessionsOf.run(id);
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

// --- links / QR Code dinâmico ---

// Endereços que já são páginas do app e não podem virar link.
const SLUGS_RESERVADOS = new Set(['admin', 'login', 'sorteio', 'api', 'vendor']);

function normalizeLink(body, { principal }) {
  const slug = principal ? '' : String(body.slug || '').trim().toLowerCase().replace(/^\/+/, '');
  const destino = String(body.destino || '').trim();
  const descricao = String(body.descricao || '').trim().slice(0, 120) || null;
  const errors = [];
  if (!principal) {
    if (!/^[a-z0-9-]{1,40}$/.test(slug)) errors.push('O endereço do link deve ter só letras minúsculas, números e hífen.');
    else if (SLUGS_RESERVADOS.has(slug)) errors.push(`"/${slug}" já é usado pelo sistema. Escolha outro endereço.`);
  }
  // Só destinos internos ("/sorteio") ou páginas http(s); nada de javascript: e afins.
  let ok = /^\/[^/\\]/.test(destino) && destino.length <= 500;
  if (!ok) {
    try {
      const u = new URL(destino);
      ok = (u.protocol === 'https:' || u.protocol === 'http:') && destino.length <= 2000;
    } catch {}
  }
  if (!ok) errors.push('Informe um destino válido, começando com https:// (ou /sorteio para o formulário).');
  if (!errors.length && destino === '/' + slug) errors.push('O link não pode apontar para ele mesmo.');
  return { slug, destino, descricao, utm: body.utm === false ? 0 : 1, errors };
}

rota('GET', '/api/admin/links', (req, res) => {
  if (!exigirUsuario(req, res)) return;
  json(res, 200, q.links.all());
});

rota('POST', '/api/admin/links', async (req, res) => {
  const u = exigirUsuario(req, res, 'admin');
  if (!u) return;
  const d = normalizeLink(await readJson(req).catch(() => ({})), { principal: false });
  if (d.errors.length) return json(res, 422, { erro: d.errors.join(' ') });
  try {
    const r = q.insertLink.run(d.slug, d.destino, d.descricao, d.utm);
    registrar(u, 'link.criado', `/${d.slug} → ${d.destino}`);
    json(res, 201, q.linkById.get(Number(r.lastInsertRowid)));
  } catch (e) {
    if (ehConflitoUnico(e)) return json(res, 409, { erro: 'Já existe um link com este endereço.' });
    throw e;
  }
});

rota('PUT', '/api/admin/links/:id', async (req, res, { id }) => {
  const u = exigirUsuario(req, res, 'admin');
  if (!u) return;
  const antes = q.linkById.get(id);
  if (!antes) return json(res, 404, { erro: 'Link não encontrado.' });
  const d = normalizeLink(await readJson(req).catch(() => ({})), { principal: antes.slug === '' });
  if (d.errors.length) return json(res, 422, { erro: d.errors.join(' ') });
  try {
    q.updateLink.run(d.slug, d.destino, d.descricao, d.utm, id);
  } catch (e) {
    if (ehConflitoUnico(e)) return json(res, 409, { erro: 'Já existe um link com este endereço.' });
    throw e;
  }
  const mudancas = [];
  if (antes.slug !== d.slug) mudancas.push(`endereço: /${antes.slug} → /${d.slug}`);
  if (antes.destino !== d.destino) mudancas.push(`destino: ${antes.destino} → ${d.destino}`);
  if (antes.utm !== d.utm) mudancas.push(d.utm ? 'UTM ligado' : 'UTM desligado');
  registrar(u, 'link.editado', `/${d.slug} · ${mudancas.join('; ') || 'só a descrição'}`);
  json(res, 200, q.linkById.get(id));
});

rota('DELETE', '/api/admin/links/:id', (req, res, { id }) => {
  const u = exigirUsuario(req, res, 'admin');
  if (!u) return;
  const link = q.linkById.get(id);
  if (!link) return json(res, 404, { erro: 'Link não encontrado.' });
  if (link.slug === '') return json(res, 409, { erro: 'O link principal não pode ser excluído, só ter o destino trocado.' });
  q.deleteLink.run(id);
  registrar(u, 'link.excluido', `/${link.slug} → ${link.destino}`);
  json(res, 200, { ok: true });
});

rota('GET', '/api/admin/links/:id/acessos', (req, res, { id }) => {
  if (!exigirUsuario(req, res)) return;
  if (!q.linkById.get(id)) return json(res, 404, { erro: 'Link não encontrado.' });
  const dias = Math.min(Math.max(Number(new URL(req.url, 'http://localhost').searchParams.get('dias')) || 30, 1), 365);
  // Lista todos os dias do período (inclusive os sem acesso) para o gráfico não pular datas.
  const lista = [];
  for (let i = dias - 1; i >= 0; i--) lista.push(hoje(new Date(Date.now() - i * 86400000)));
  const inicio = lista[0];
  const porDia = new Map(q.acessosPorDia.all(id, inicio).map((r) => [r.dia, r.total]));
  const porHora = new Map(q.acessosPorHora.all(id, inicio).map((r) => [r.hora, r.total]));
  json(res, 200, {
    dias: lista.map((dia) => ({ dia, total: porDia.get(dia) || 0 })),
    horas: Array.from({ length: 24 }, (_, h) => ({ hora: h, total: porHora.get(h) || 0 })),
    dispositivos: q.acessosPorDispositivo.all(id, inicio),
    hoje: hoje(),
  });
});

// Pré-visualizações de link (WhatsApp, redes sociais) e robôs não contam como acesso.
const ROBO = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|slack|discord|skype|preview|curl|wget|python-requests|go-http-client/i;

function dispositivo(ua) {
  if (/iphone|ipad|ipod/i.test(ua)) return 'iphone';
  if (/android/i.test(ua)) return 'android';
  if (/windows|macintosh|linux|cros/i.test(ua)) return 'computador';
  return 'outro';
}

// Acrescenta etiquetas UTM para o Google Analytics / Instagram saberem que o acesso veio do QR Code.
// Destinos internos (/sorteio) e endereços que já têm UTM ficam como estão.
function comUtm(destino, slug) {
  let u;
  try {
    u = new URL(destino);
  } catch {
    return destino;
  }
  if ([...u.searchParams.keys()].some((k) => k.startsWith('utm_'))) return destino;
  u.searchParams.set('utm_source', 'qrcode');
  u.searchParams.set('utm_medium', 'qr');
  u.searchParams.set('utm_campaign', slug || 'principal');
  return u.toString();
}

// Redireciona um link para o destino atual. 302 + no-store para os celulares não guardarem o
// destino: assim a troca no painel vale na hora para o QR Code já impresso.
function redirecionarLink(req, res, link) {
  const ua = String(req.headers['user-agent'] || '');
  if (link.id && !ROBO.test(ua)) {
    const agora = new Date();
    q.countClick.run(link.id);
    q.insertAcesso.run(link.id, hoje(agora), horaLocal(agora), dispositivo(ua));
  }
  const destino = link.utm ? comUtm(link.destino, link.slug) : link.destino;
  send(res, 302, '', { Location: destino, 'Cache-Control': 'no-store' });
}

rota('GET', '/api/admin/auditoria', (req, res) => {
  if (!exigirUsuario(req, res, 'admin')) return;
  json(res, 200, q.logs.all());
});

// --- páginas ---

rota('GET', '/', (req, res) => redirecionarLink(req, res, q.linkBySlug.get('') || { id: 0, slug: '', destino: '/sorteio' }));

rota('GET', '/sorteio', (req, res) => serveFile(res, 'index.html'));

rota('GET', '/privacidade', (req, res) => serveFile(res, 'privacidade.html'));

rota('GET', '/definir-senha', (req, res) => serveFile(res, 'definir-senha.html'));

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

// Política de segurança de conteúdo: só carrega scripts/estilos do próprio site (e as fontes do
// Google), não deixa o site ser embutido em outro (clickjacking) e não envia dados para fora.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.regex);
      if (m) return await r.handler(req, res, Object.fromEntries(r.keys.map((k, i) => [k, Number(m[i + 1])])));
    }
    if (req.method !== 'GET') return send(res, 405, 'Método não permitido');
    if (pathname === '/index.html') return redirect(res, '/sorteio');
    const slug = pathname.toLowerCase().match(/^\/([a-z0-9-]{1,40})\/?$/);
    const link = slug && q.linkBySlug.get(slug[1]);
    if (link) return redirecionarLink(req, res, link);
    if (pathname === '/admin.html') return redirect(res, '/admin');
    if (pathname === '/login.html') return redirect(res, '/login');
    let arquivo;
    try {
      arquivo = decodeURIComponent(pathname).replace(/^\/+/, '');
    } catch {
      return send(res, 400, 'Endereço inválido');
    }
    return serveFile(res, arquivo);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { erro: 'Erro interno. Tente novamente.' });
  }
});

// Apaga os cadastros (e seus sorteios) mais antigos que RETENCAO_DIAS, conforme o Aviso de Privacidade.
function aplicarRetencao() {
  if (!RETENCAO_DIAS) return;
  const limite = hoje(new Date(Date.now() - RETENCAO_DIAS * 86400000));
  const ids = q.expiredIds.all(limite).map((r) => r.id);
  if (!ids.length) return;
  transacao(() => {
    for (const id of ids) {
      q.deleteDrawsOf.run(id);
      q.delete.run(id);
    }
  });
  registrar(null, 'retencao', `${ids.length} cadastros anteriores a ${diaBr(limite)} apagados (retenção de ${RETENCAO_DIAS} dias)`);
  console.log(`Retenção: ${ids.length} cadastros antigos apagados.`);
}
aplicarRetencao();
setInterval(aplicarRetencao, 6 * 60 * 60 * 1000).unref();

criarPrimeiroAdmin().then(() => {
  server.listen(PORT, () => {
    console.log(`Sorteio "${EVENT_NAME}" rodando em http://localhost:${PORT}`);
    console.log(`Painel: http://localhost:${PORT}/admin`);
  });
});
