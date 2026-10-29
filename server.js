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
// Nome do sistema (tela de login, painel, e-mails e app autenticador).
const APP_NOME = process.env.APP_NOME || 'Importadora Link';
// Endereço público usado para montar os links e QR Codes no painel (ex.: https://importadoravw.link).
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const CODE_PREFIX = process.env.CODE_PREFIX ?? 'VW-';
// Fuso usado para definir o "dia do cadastro" (cada evento sorteia só entre os cadastros do seu dia).
const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'sorteio.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Cópias de segurança automáticas do banco (por padrão numa pasta "backups" ao lado dele).
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const BACKUP_MANTER = Math.max(1, Number(process.env.BACKUP_MANTER) || 28);
const BACKUP_HORAS = Math.max(1, Number(process.env.BACKUP_HORAS) || 6);
const SESSION_HOURS = 12;
// Nome que aparece no app autenticador (Google Authenticator etc.) ao lado do e-mail.
const TOTP_EMISSOR = process.env.TOTP_EMISSOR || APP_NOME;
// Dados do controlador exibidos no Aviso de Privacidade (/privacidade).
const CONTROLADOR_NOME = process.env.CONTROLADOR_NOME || EVENT_NAME;
// Marca mostrada ao participante (tela do código e e-mail de comprovante). O nome do sistema
// (APP_NOME, "Central de Gestão") aparece só para a equipe.
const MARCA = process.env.MARCA_NOME || 'Importadora Volkswagen';
// Endereço do formulário de cadastro (o link principal do QR Code leva para cá).
const FORMULARIO = '/cadastro';
// Instagram da importadora, divulgado na tela do código e no comprovante (opcional).
const INSTAGRAM_URL = (() => {
  const url = process.env.INSTAGRAM_URL ?? 'https://www.instagram.com/importadoravolkswagen/';
  return /^https:\/\/(www\.)?instagram\.com\/[\w.]+\/?$/i.test(url) ? url : '';
})();
const INSTAGRAM_ARROBA = INSTAGRAM_URL ? '@' + INSTAGRAM_URL.replace(/\/$/, '').split('/').pop() : '';
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
  CREATE INDEX IF NOT EXISTS participantes_cpf ON participantes (cpf);
  -- Um cadastro por pessoa (CPF) vale para todos os eventos; cada evento em que ela aparece (e envia
  -- o formulário de novo) vira uma presença, com o dia e o evento escolhido no formulário.
  CREATE TABLE IF NOT EXISTS presencas (
    participante_id INTEGER NOT NULL REFERENCES participantes(id),
    dia             TEXT NOT NULL,
    evento          TEXT NOT NULL DEFAULT '',
    criado_em       TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (participante_id, dia, evento)
  );
  -- Campos extras do formulário, configurados no painel (aba Formulário). O campo "evento" é especial:
  -- a resposta vai para a presença; os demais ficam em participantes.respostas (JSON).
  CREATE TABLE IF NOT EXISTS campos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    rotulo      TEXT NOT NULL,
    tipo        TEXT NOT NULL CHECK (tipo IN ('texto', 'selecao', 'caixa')),
    opcoes      TEXT NOT NULL DEFAULT '[]',
    obrigatorio INTEGER NOT NULL DEFAULT 0,
    ativo       INTEGER NOT NULL DEFAULT 1,
    ordem       INTEGER NOT NULL DEFAULT 0,
    sistema     TEXT,
    criado_em   TEXT NOT NULL DEFAULT (datetime('now'))
  );
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
  INSERT OR IGNORE INTO links (slug, destino, descricao) VALUES ('', '/cadastro', 'Link principal (QR Code impresso)');
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
if (!db.prepare('PRAGMA table_info(acessos)').all().some((c) => c.name === 'navegador')) {
  db.exec("ALTER TABLE acessos ADD COLUMN navegador TEXT NOT NULL DEFAULT 'outro'");
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
  // Recebe e-mail a cada novo cadastro (só vale para administradores).
  ['notif_cadastros', 'INTEGER NOT NULL DEFAULT 1'],
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

// Presenças de antes do campo "evento": a tabela ganha a coluna e passa a ter o evento na chave.
if (!db.prepare('PRAGMA table_info(presencas)').all().some((c) => c.name === 'evento')) {
  db.exec(`
    BEGIN;
    CREATE TABLE presencas_novo (
      participante_id INTEGER NOT NULL REFERENCES participantes(id),
      dia             TEXT NOT NULL,
      evento          TEXT NOT NULL DEFAULT '',
      criado_em       TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (participante_id, dia, evento)
    );
    INSERT INTO presencas_novo (participante_id, dia, criado_em) SELECT participante_id, dia, criado_em FROM presencas;
    DROP TABLE presencas;
    ALTER TABLE presencas_novo RENAME TO presencas;
    COMMIT;
  `);
}
db.exec(`
  CREATE INDEX IF NOT EXISTS presencas_dia ON presencas (dia);
  CREATE INDEX IF NOT EXISTS presencas_evento ON presencas (evento);
`);
if (!db.prepare('PRAGMA table_info(participantes)').all().some((c) => c.name === 'respostas')) {
  db.exec("ALTER TABLE participantes ADD COLUMN respostas TEXT NOT NULL DEFAULT '{}'");
}
// O campo "Evento" sempre existe (pode ser desativado, não excluído).
const CAMPO_EVENTO = `INSERT INTO campos (rotulo, tipo, opcoes, obrigatorio, ativo, ordem, sistema)
  SELECT 'Evento', 'selecao', '["XX Fórum de Gastroenterologia Equina","Showroom"]', 1, 1, 0, 'evento'
  WHERE NOT EXISTS (SELECT 1 FROM campos WHERE sistema = 'evento')`;
db.exec(CAMPO_EVENTO);

// Cadastros de antes das presenças: o dia do cadastro conta como presença naquele evento.
const PRESENCAS_DO_CADASTRO = `INSERT OR IGNORE INTO presencas (participante_id, dia, criado_em)
  SELECT id, data_cadastro, criado_em FROM participantes p
  WHERE NOT EXISTS (SELECT 1 FROM presencas WHERE participante_id = p.id AND dia = p.data_cadastro)`;
db.exec(PRESENCAS_DO_CADASTRO);
// O formulário já esteve em /sorteio e em /brindes.
const LINKS_FORMULARIO = `UPDATE links SET destino = '${FORMULARIO}' WHERE destino IN ('/sorteio', '/brindes')`;
db.exec(LINKS_FORMULARIO);

const PARTICIPANTE_COLS = 'id, nome, cpf, telefone, email, data_cadastro, criado_em, aceite_em, termos_versao, aceita_marketing, respostas';
// Presenças de cada cadastro, como JSON: [{"dia":"2026-10-22","evento":"Showroom"}, …].
const PRESENCAS_JSON = (id) => `(SELECT json_group_array(json_object('dia', dia, 'evento', evento))
  FROM (SELECT dia, evento FROM presencas WHERE participante_id = ${id} ORDER BY dia, criado_em, rowid)) AS presencas`;
const COM_PRESENCAS = `${PARTICIPANTE_COLS}, ${PRESENCAS_JSON('participantes.id')}`;
// Converte os campos JSON vindos do banco.
const lerParticipante = (p) => p && {
  ...p,
  presencas: JSON.parse(p.presencas || '[]'),
  respostas: JSON.parse(p.respostas || '{}'),
};
const USUARIO_COLS = 'id, nome, email, papel, ativo, criado_em, confirmado, totp_ativo, notif_cadastros';

const q = {
  insert: db.prepare(`
    INSERT INTO participantes (nome, cpf, telefone, email, data_cadastro, aceite_em, termos_versao, aceita_marketing, respostas)
    VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)`),
  byCpf: db.prepare('SELECT id, nome, telefone, email, respostas FROM participantes WHERE cpf = ? ORDER BY id LIMIT 1'),
  insertPresenca: db.prepare('INSERT OR IGNORE INTO presencas (participante_id, dia, evento) VALUES (?, ?, ?)'),
  updateRespostas: db.prepare('UPDATE participantes SET respostas = ? WHERE id = ?'),
  campos: db.prepare('SELECT * FROM campos ORDER BY ordem, id'),
  campoEvento: db.prepare("SELECT * FROM campos WHERE sistema = 'evento'"),
  updateEventos: db.prepare("UPDATE campos SET opcoes = ?, ativo = ? WHERE sistema = 'evento'"),
  renomearEvento: db.prepare('UPDATE OR IGNORE presencas SET evento = ? WHERE evento = ?'),
  apagarEventoAntigo: db.prepare('DELETE FROM presencas WHERE evento = ?'),
  eventos: db.prepare("SELECT evento, COUNT(DISTINCT participante_id) AS total FROM presencas WHERE evento <> '' GROUP BY evento ORDER BY MIN(dia), evento"),
  byEvento: db.prepare(`SELECT ${COM_PRESENCAS} FROM participantes
    WHERE id IN (SELECT participante_id FROM presencas WHERE evento = ?) ORDER BY id`),
  eligibleByEvento: db.prepare(`
    SELECT id FROM participantes
    WHERE id IN (SELECT participante_id FROM presencas WHERE evento = ?) AND id NOT IN (SELECT participante_id FROM sorteios)
    ORDER BY id`),
  deletePresencasOf: db.prepare('DELETE FROM presencas WHERE participante_id = ?'),
  // Retenção: conta a partir da última presença.
  expiredIds: db.prepare(`
    SELECT p.id FROM participantes p
    WHERE COALESCE((SELECT MAX(dia) FROM presencas WHERE participante_id = p.id), p.data_cadastro) < ?`),
  all: db.prepare(`SELECT ${COM_PRESENCAS} FROM participantes ORDER BY id`),
  byDate: db.prepare(`SELECT ${COM_PRESENCAS} FROM participantes
    WHERE id IN (SELECT participante_id FROM presencas WHERE dia = ?) ORDER BY id`),
  datas: db.prepare('SELECT dia AS data, COUNT(DISTINCT participante_id) AS total FROM presencas GROUP BY dia ORDER BY dia DESC'),
  eligible: db.prepare(`
    SELECT id FROM participantes
    WHERE id NOT IN (SELECT participante_id FROM sorteios)
    ORDER BY id`),
  eligibleByDate: db.prepare(`
    SELECT id FROM participantes
    WHERE id IN (SELECT participante_id FROM presencas WHERE dia = ?) AND id NOT IN (SELECT participante_id FROM sorteios)
    ORDER BY id`),
  byId: db.prepare(`SELECT ${COM_PRESENCAS} FROM participantes WHERE id = ?`),
  update: db.prepare('UPDATE participantes SET nome = ?, cpf = ?, telefone = ?, email = ? WHERE id = ?'),
  delete: db.prepare('DELETE FROM participantes WHERE id = ?'),
  deleteDrawsOf: db.prepare('DELETE FROM sorteios WHERE participante_id = ?'),
  insertDraw: db.prepare('INSERT INTO sorteios (participante_id) VALUES (?)'),
  draws: db.prepare(`
    SELECT s.id AS sorteio, s.sorteado_em, p.id, p.nome, p.cpf, p.telefone, p.email, p.data_cadastro, ${PRESENCAS_JSON('p.id')}
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
  updateUser: db.prepare('UPDATE usuarios SET nome = ?, email = ?, papel = ?, ativo = ?, notif_cadastros = ? WHERE id = ?'),
  adminsNotificados: db.prepare("SELECT email FROM usuarios WHERE papel = 'admin' AND ativo = 1 AND confirmado = 1 AND notif_cadastros = 1"),
  cadastrosPorDia: db.prepare('SELECT data_cadastro AS dia, COUNT(*) AS total FROM participantes WHERE data_cadastro >= ? GROUP BY data_cadastro'),
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
  logs: db.prepare('SELECT id, usuario_nome, acao, detalhe, criado_em FROM auditoria ORDER BY criado_em DESC, id DESC LIMIT 300'),

  links: db.prepare('SELECT id, slug, destino, descricao, utm, cliques, atualizado_em FROM links ORDER BY slug <> \'\', slug'),
  linkById: db.prepare('SELECT id, slug, destino, descricao, utm, cliques, atualizado_em FROM links WHERE id = ?'),
  linkBySlug: db.prepare('SELECT id, slug, destino, utm FROM links WHERE slug = ?'),
  insertLink: db.prepare('INSERT INTO links (slug, destino, descricao, utm) VALUES (?, ?, ?, ?)'),
  updateLink: db.prepare("UPDATE links SET slug = ?, destino = ?, descricao = ?, utm = ?, atualizado_em = datetime('now') WHERE id = ?"),
  insertAcesso: db.prepare('INSERT INTO acessos (link_id, dia, hora, dispositivo, navegador) VALUES (?, ?, ?, ?, ?)'),
  acessosPorNavegador: db.prepare(`
    SELECT navegador, COUNT(*) AS total FROM acessos WHERE link_id = ? AND dia >= ?
    GROUP BY navegador ORDER BY total DESC`),
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

// Respostas da API nunca ficam em cache (nem no navegador nem na CDN da hospedagem): o formulário
// precisa sempre da lista de eventos atual.
function json(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
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
  // application/octet-stream (envio do arquivo de backup) também exige preflight de outro site.
  const tipo = String(req.headers['content-type'] || '');
  if (req.method === 'POST' && !tipo.startsWith('application/json') && !tipo.startsWith('application/octet-stream')) return false;
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
// Conta só as tentativas recusadas: no evento muita gente usa a mesma rede (mesmo IP), e cadastros
// que deram certo não podem travar os próximos.
const limiteCadastro = criarLimitador(30, 10 * 60 * 1000);

// Diagnóstico desde que o app iniciou (aparece no painel): cadastros concluídos, tentativas
// recusadas por motivo e erros de JavaScript que aconteceram no formulário dos participantes.
const diagnostico = { desde: new Date().toISOString(), concluidos: 0, recusados: {}, errosFormulario: [] };
function recusar(res, req, status, motivo, dados) {
  diagnostico.recusados[motivo] = (diagnostico.recusados[motivo] || 0) + 1;
  limiteCadastro.contar(clientIp(req));
  console.warn(`Cadastro recusado (${status}): ${motivo}`);
  json(res, status, dados);
}
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
  // Erro de cada campo, para o formulário destacar o campo certo.
  const porCampo = {};
  if (nome.length < 3 || nome.length > 120 || nome.split(' ').length < 2) porCampo.nome = 'Informe nome e sobrenome.';
  if (telefone.length < 10 || telefone.length > 13) porCampo.telefone = 'Informe um telefone válido com DDD.';
  if (!cpfValido(cpf)) porCampo.cpf = 'CPF inválido. Confira os números.';
  if (!emailValido(email)) porCampo.email = 'Informe um e-mail válido.';
  if (exigirAceite && body.aceite !== true) porCampo.aceite = 'Para participar, é preciso concordar com o Aviso de Privacidade.';
  return { nome, cpf, telefone, email, marketing: body.marketing === true ? 1 : 0, errors: Object.values(porCampo), porCampo };
}

// ---------- campos configuráveis do formulário ----------

const lerCampo = (c) => ({ ...c, opcoes: JSON.parse(c.opcoes || '[]') });
const camposAtivos = () => q.campos.all().filter((c) => c.ativo).map(lerCampo);

// Confere as respostas dos campos extras enviadas pelo formulário.
function normalizeRespostas(body) {
  const recebidas = body.respostas && typeof body.respostas === 'object' ? body.respostas : {};
  const respostas = {};
  let evento = '';
  const porCampo = {};
  for (const c of camposAtivos()) {
    let v = recebidas[c.id];
    if (c.tipo === 'caixa') v = v === true;
    else v = String(v ?? '').trim().slice(0, 300);
    const chave = `campo-${c.id}`;
    if (c.tipo === 'selecao' && v && !c.opcoes.includes(v)) { porCampo[chave] = 'Escolha uma das opções da lista.'; continue; }
    if (c.obrigatorio && !v) {
      porCampo[chave] = c.sistema === 'evento' ? 'Selecione o evento.' : c.tipo === 'selecao' ? 'Escolha uma opção.' : c.tipo === 'caixa' ? 'Marque esta opção para continuar.' : 'Preencha este campo.';
      continue;
    }
    if (c.sistema === 'evento') evento = v;
    else if (v !== '' && v !== false) respostas[c.id] = v;
  }
  return { respostas, evento, errors: Object.values(porCampo), porCampo };
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
  return { nome, email, papel, senha, ativo: body.ativo === false ? 0 : 1, notif: body.notifCadastros === false ? 0 : 1, errors };
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
<tr><td style="background:#011250;color:#fff;padding:18px 24px;font-size:16px;font-weight:bold">${escHtml(APP_NOME)} · Central de Gestão</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 12px;font-size:20px;color:#011250">${escHtml(titulo)}</h1>
${paragrafos.map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${escHtml(p)}</p>`).join('')}
${link ? `<p style="margin:20px 0"><a href="${escHtml(link)}" style="display:inline-block;background:#0a1a80;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px">${escHtml(botao)}</a></p>
<p style="margin:0;font-size:12px;color:#64748b;word-break:break-all">Se o botão não funcionar, copie e cole no navegador:<br>${escHtml(link)}</p>` : ''}
${rodape ? `<p style="margin:20px 0 0;font-size:12px;color:#64748b">${escHtml(rodape)}</p>` : ''}
</td></tr></table></td></tr></table></body></html>`;
  return { texto, html };
}

// Comprovante de participação enviado a quem se cadastra: com a marca da importadora, sem o nome
// do sistema interno.
function montarComprovante({ nome, cod }) {
  const primeiro = nome.split(' ')[0];
  const privacidade = PUBLIC_URL ? ` Saiba como usamos seus dados: ${PUBLIC_URL}/privacidade` : '';
  const texto = [
    MARCA, '',
    `${primeiro}, você está concorrendo a brindes exclusivos!`, '',
    `Seu código de participação: ${cod}`,
    ...(INSTAGRAM_URL ? ['', `Siga a ${MARCA} no Instagram e acompanhe as novidades: ${INSTAGRAM_ARROBA} ${INSTAGRAM_URL}`] : []), '',
    `Equipe ${MARCA}`, '',
    `Você recebeu este e-mail porque se cadastrou para concorrer a brindes da ${MARCA}.${privacidade}`,
  ].join('\n');
  const logo = PUBLIC_URL ? `<img src="${escHtml(PUBLIC_URL)}/qr-logo.png" width="56" height="56" alt="" style="display:block;margin:0 auto 10px;border-radius:50%">` : '';
  const html = `<!doctype html><html><body style="margin:0;background:#eef1f7;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:14px;overflow:hidden">
<tr><td align="center" style="background:#011250;color:#fff;padding:26px 24px 22px">
${logo}<div style="font-size:18px;font-weight:bold;letter-spacing:.02em">${escHtml(MARCA)}</div>
</td></tr>
<tr><td style="padding:28px 24px 8px;text-align:center">
<h1 style="margin:0 0 6px;font-size:22px;color:#011250">${escHtml(primeiro)}, você está concorrendo a brindes exclusivos!</h1>
<p style="margin:0 0 20px;font-size:15px;color:#475569">Seu cadastro foi confirmado. Este é o seu código de participação:</p>
<div style="margin:0 auto;display:inline-block;background:#011250;color:#fff;font-size:34px;font-weight:bold;letter-spacing:.06em;padding:14px 28px;border-radius:10px">${escHtml(cod)}</div>
</td></tr>
<tr><td style="padding:18px 0 0"></td></tr>
${INSTAGRAM_URL ? `<tr><td style="padding:6px 24px 26px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;border-radius:12px"><tr><td align="center" style="padding:20px 18px">
<div style="font-size:16px;font-weight:bold;color:#011250">Siga a ${escHtml(MARCA)} no Instagram</div>
<div style="font-size:13px;color:#64748b;margin:4px 0 14px">Lançamentos, ofertas e novidades em primeira mão.</div>
<a href="${escHtml(INSTAGRAM_URL)}" style="display:inline-block;background:#0a1a80;color:#fff;text-decoration:none;font-weight:bold;font-size:14px;padding:12px 22px;border-radius:8px">Seguir ${escHtml(INSTAGRAM_ARROBA)}</a>
</td></tr></table></td></tr>` : '<tr><td style="padding:0 0 14px"></td></tr>'}
<tr><td align="center" style="padding:0 24px 24px;font-size:13px;color:#64748b">Equipe ${escHtml(MARCA)}</td></tr>
<tr><td style="background:#f8fafc;padding:14px 24px;font-size:11px;color:#94a3b8;line-height:1.5">
Você recebeu este e-mail porque se cadastrou para concorrer a brindes da ${escHtml(MARCA)}. Este é um e-mail automático, não é preciso responder.${PUBLIC_URL ? ` <a href="${escHtml(PUBLIC_URL)}/privacidade" style="color:#64748b">Como usamos seus dados</a>.` : ''}
</td></tr></table></td></tr></table></body></html>`;
  return { texto, html };
}

async function enviarEmail(para, assunto, conteudo) {
  await mailer.enviar({ para, assunto, ...(conteudo.html ? conteudo : montarEmail(conteudo)) });
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
    await enviarEmail(alvo.email, `Confirme seu acesso — ${APP_NOME}`, {
      titulo: `Olá, ${alvo.nome.split(' ')[0]}!`,
      paragrafos: [
        `${quemConvidou.nome} criou um acesso para você na Central de Gestão ${APP_NOME}.`,
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
  enviarEmail(usuario.email, `Sua senha foi alterada — ${APP_NOME}`, {
    titulo: 'Sua senha foi alterada',
    paragrafos: [
      `A senha do seu acesso à Central de Gestão ${APP_NOME} (${usuario.email}) acabou de ser alterada.`,
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

// Fila de e-mails: envia um de cada vez em segundo plano, para um pico de cadastros no evento não
// abrir dezenas de conexões com o servidor de e-mail nem atrasar a resposta do formulário.
let filaEmail = Promise.resolve();
function enfileirarEmail(para, assunto, conteudo) {
  if (!mailer.configurado()) return;
  filaEmail = filaEmail
    .then(() => enviarEmail(para, assunto, conteudo))
    .catch((e) => console.error(`Falha ao enviar e-mail para ${para}:`, e.message));
}

// A cada cadastro: confirmação com o código para quem se inscreveu e aviso para os administradores
// que deixaram ligada a opção "Receber e-mail a cada novo cadastro".
// Respostas dos campos extras como linhas "Campo: resposta".
function textoRespostas(respostas = {}) {
  const campos = new Map(q.campos.all().map((c) => [String(c.id), c.rotulo]));
  return Object.entries(respostas).filter(([id]) => campos.has(id))
    .map(([id, v]) => `${campos.get(id)}: ${v === true ? 'sim' : v}`);
}

function notificarCadastro(p) {
  const cod = codigo(p.id);
  enfileirarEmail(p.email, `Você está concorrendo a brindes! Seu código é ${cod} · ${MARCA}`,
    montarComprovante({ nome: p.nome, cod }));
  const mascara = `***.${p.cpf.slice(3, 6)}.${p.cpf.slice(6, 9)}-**`;
  for (const { email } of q.adminsNotificados.all()) {
    enfileirarEmail(email, `Novo cadastro ${cod} — ${p.nome}`, {
      titulo: `Novo cadastro: ${cod}`,
      paragrafos: [
        `Nome: ${p.nome}`,
        `CPF: ${mascara} · Telefone: ${p.telefone} · E-mail: ${p.email}`,
        `Cadastro em ${diaBr(p.dia)}${p.evento ? ` · evento: ${p.evento}` : ''} · aceita ofertas: ${p.marketing ? 'sim' : 'não'}`,
        ...textoRespostas(p.respostas),
      ],
      botao: 'Abrir o painel',
      link: PUBLIC_URL ? `${PUBLIC_URL}/admin` : null,
      rodape: 'Para não receber mais estes avisos, desmarque "Receber e-mail a cada novo cadastro" no seu usuário, na aba Usuários.',
    });
  }
}

// ---------- cópias de segurança (backup) do banco ----------

// Inclui milissegundos e um sufixo aleatório: dois backups no mesmo segundo (ex.: o de segurança
// feito logo antes de uma restauração) não podem ter o mesmo nome.
const nomeBackup = (motivo) =>
  `sorteio-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)}-${crypto.randomBytes(2).toString('hex')}-${motivo}.db`;

// VACUUM INTO grava uma cópia consistente do banco sem parar o app.
function fazerBackup(motivo = 'auto') {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const arquivo = path.join(BACKUP_DIR, nomeBackup(motivo));
  db.exec(`VACUUM INTO '${arquivo.replace(/'/g, "''")}'`);
  const antigos = listarBackups().slice(BACKUP_MANTER);
  for (const b of antigos) fs.rmSync(path.join(BACKUP_DIR, b.nome), { force: true });
  return path.basename(arquivo);
}

function listarBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((n) => /^sorteio-[\w-]+\.db$/.test(n))
    .map((nome) => {
      const st = fs.statSync(path.join(BACKUP_DIR, nome));
      return { nome, tamanho: st.size, criado_em: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.criado_em < b.criado_em ? 1 : -1));
}

// Tabelas restauradas (sessões, tickets de login e links de e-mail não voltam: todos entram de novo).
// A auditoria não é substituída: o histórico do backup é somado ao atual, para não perder o registro
// do que aconteceu entre o backup e a restauração.
const TABELAS_RESTAURAR = ['usuarios', 'participantes', 'presencas', 'sorteios', 'links', 'acessos', 'campos'];

// Confere se o arquivo é um banco deste sistema e conta o que ele tem.
function inspecionarBackup(arquivo) {
  const cab = Buffer.alloc(16);
  const fd = fs.openSync(arquivo, 'r');
  fs.readSync(fd, cab, 0, 16, 0);
  fs.closeSync(fd);
  if (cab.toString('latin1') !== 'SQLite format 3\u0000') throw new Error('O arquivo não é um banco de dados SQLite.');
  const b = new DatabaseSync(arquivo, { readOnly: true });
  try {
    const tabelas = new Set(b.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
    if (!tabelas.has('participantes') || !tabelas.has('usuarios')) throw new Error('O arquivo não parece ser um backup deste sistema.');
    const n = (t) => (tabelas.has(t) ? b.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n : 0);
    const admins = b.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE papel = 'admin' AND ativo = 1").get().n;
    if (!admins) throw new Error('O backup não tem nenhum administrador ativo; restaurar deixaria o painel sem acesso.');
    return { participantes: n('participantes'), usuarios: n('usuarios'), sorteios: n('sorteios'), links: n('links') };
  } finally {
    b.close();
  }
}

// Copia o conteúdo do backup para o banco em uso (sem trocar o arquivo, então o app não precisa
// reiniciar). Antes, guarda uma cópia do estado atual para poder desfazer.
function restaurarBackup(arquivo) {
  const resumo = inspecionarBackup(arquivo);
  const seguranca = fazerBackup('antes-de-restaurar');
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`ATTACH DATABASE '${arquivo.replace(/'/g, "''")}' AS origem`);
    try {
      transacao(() => {
        db.exec('DELETE FROM sessoes; DELETE FROM login_tickets; DELETE FROM tokens_email;');
        for (const t of TABELAS_RESTAURAR) {
          const destino = db.prepare(`PRAGMA main.table_info(${t})`).all().map((c) => c.name);
          const origem = new Set(db.prepare(`PRAGMA origem.table_info(${t})`).all().map((c) => c.name));
          db.exec(`DELETE FROM main.${t}`);
          if (!origem.size) continue;
          // Só as colunas que existem nos dois lados: um backup de versão anterior também serve.
          const cols = destino.filter((c) => origem.has(c)).join(', ');
          db.exec(`INSERT INTO main.${t} (${cols}) SELECT ${cols} FROM origem.${t}`);
        }
        if (db.prepare("SELECT 1 FROM origem.sqlite_master WHERE name = 'auditoria'").get()) {
          db.exec(`
            INSERT INTO main.auditoria (usuario_id, usuario_nome, acao, detalhe, criado_em)
            SELECT o.usuario_id, o.usuario_nome, o.acao, o.detalhe, o.criado_em FROM origem.auditoria o
            WHERE NOT EXISTS (
              SELECT 1 FROM main.auditoria a WHERE a.criado_em = o.criado_em AND a.acao = o.acao
                AND a.detalhe IS o.detalhe AND a.usuario_nome IS o.usuario_nome)`);
        }
        // Backup de antes das presenças: recria a partir do dia de cadastro.
        db.exec(PRESENCAS_DO_CADASTRO);
        db.exec(LINKS_FORMULARIO);
        db.exec(CAMPO_EVENTO);
        // Mantém a numeração dos códigos (VW-0001…) continuando de onde o backup parou.
        db.exec('DELETE FROM main.sqlite_sequence');
        if (db.prepare("SELECT 1 FROM origem.sqlite_master WHERE name = 'sqlite_sequence'").get()) {
          db.exec("INSERT INTO main.sqlite_sequence (name, seq) SELECT name, seq FROM origem.sqlite_sequence WHERE name <> 'auditoria'");
        }
        db.exec("INSERT INTO main.sqlite_sequence (name, seq) SELECT 'auditoria', COALESCE(MAX(id), 0) FROM main.auditoria");
      });
    } finally {
      db.exec('DETACH DATABASE origem');
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  unificarDuplicados();
  unificarCamposExtras();
  return { ...resumo, seguranca };
}

function backupAutomatico() {
  try {
    const nome = fazerBackup('auto');
    console.log(`Backup automático: ${path.join(BACKUP_DIR, nome)}`);
  } catch (e) {
    console.error('Falha no backup automático:', e.message);
  }
}

// ---------- rotas ----------

const routes = [];
function rota(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '(\\d+)')) + '$');
  routes.push({ method, regex, keys, handler });
}

rota('GET', '/api/config', (req, res) => json(res, 200, {
  evento: EVENT_NAME,
  app: APP_NOME,
  marca: MARCA,
  campos: camposAtivos().map(({ id, rotulo, tipo, opcoes, obrigatorio, sistema }) => ({ id, rotulo, tipo, opcoes, obrigatorio, sistema })),
  instagram: INSTAGRAM_URL ? { url: INSTAGRAM_URL, arroba: INSTAGRAM_ARROBA } : null,
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

// Para a tela do código dizer para onde foi o comprovante (e-mail mascarado: f***@gmail.com).
const avisoEmail = (email) => (mailer.configurado() && email
  ? { emailEnviado: email.replace(/^(.)[^@]*(@.*)$/, '$1***$2') }
  : {});

rota('POST', '/api/cadastro', async (req, res) => {
  if (limiteCadastro.excedeu(clientIp(req))) {
    diagnostico.recusados['muitas tentativas'] = (diagnostico.recusados['muitas tentativas'] || 0) + 1;
    return json(res, 429, { erro: 'Muitas tentativas. Aguarde alguns minutos.' });
  }
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return recusar(res, req, 400, 'pedido inválido', { erro: e.message });
  }
  // Campo "isca" invisível: bots costumam preenchê-lo.
  if (body.site) return recusar(res, req, 400, 'robô (campo isca)', { erro: 'Cadastro inválido.' });

  const data = normalize(body);
  const extras = normalizeRespostas(body);
  const erros = [...data.errors, ...extras.errors];
  if (erros.length) {
    const campos = { ...data.porCampo, ...extras.porCampo };
    const nomes = Object.keys(campos).map((k) => (k.startsWith('campo-') ? 'evento' : k)).join(', ');
    return recusar(res, req, 422, `dados inválidos (${nomes})`, { erro: erros.join(' '), campos });
  }

  // Um cadastro por CPF, válido em todos os eventos. Quem volta em outro evento envia o formulário de
  // novo e ganha a presença daquele dia e evento, com o mesmo código.
  const dia = hoje();
  const existing = q.byCpf.get(data.cpf);
  if (existing) {
    // Só devolve o código se o telefone conferir: sem isso, qualquer um que digitasse o CPF de
    // outra pessoa descobriria o nome e o código dela.
    if (existing.telefone !== data.telefone) {
      return recusar(res, req, 409, 'CPF já cadastrado com outro telefone', {
        erro: 'Este CPF já está cadastrado com outro telefone.',
        campos: { telefone: 'Este CPF já está cadastrado com outro telefone. Se foi você, informe o mesmo telefone do cadastro.' },
      });
    }
    const novaPresenca = transacao(() => {
      q.updateRespostas.run(JSON.stringify({ ...JSON.parse(existing.respostas || '{}'), ...extras.respostas }), existing.id);
      return q.insertPresenca.run(existing.id, dia, extras.evento).changes > 0;
    });
    return json(res, 200, { id: existing.id, nome: existing.nome, data_cadastro: dia, jaCadastrado: true, novaPresenca, ...avisoEmail(existing.email) });
  }
  const id = transacao(() => {
    const r = q.insert.run(data.nome, data.cpf, data.telefone, data.email, dia, TERMOS_VERSAO, data.marketing, JSON.stringify(extras.respostas));
    const novo = Number(r.lastInsertRowid);
    q.insertPresenca.run(novo, dia, extras.evento);
    return novo;
  });
  diagnostico.concluidos++;
  notificarCadastro({ id, ...data, dia, evento: extras.evento, respostas: extras.respostas });
  return json(res, 201, { id, nome: data.nome, data_cadastro: dia, jaCadastrado: false, ...avisoEmail(data.email) });
});

// Erros de JavaScript no formulário dos participantes (só a mensagem e o navegador, sem dados pessoais).
const limiteErros = criarLimitador(10, 10 * 60 * 1000);
rota('POST', '/api/erro-formulario', async (req, res) => {
  const ip = clientIp(req);
  if (limiteErros.excedeu(ip)) return json(res, 429, { ok: false });
  limiteErros.contar(ip);
  const body = await readJson(req, 2000).catch(() => ({}));
  const erro = {
    quando: new Date().toISOString(),
    mensagem: String(body.mensagem || '').slice(0, 300),
    navegador: `${dispositivo(req.headers['user-agent'] || '')} · ${navegador(req.headers['user-agent'] || '')}`,
  };
  diagnostico.errosFormulario = [erro, ...diagnostico.errosFormulario].slice(0, 20);
  console.warn(`Erro no formulário (${erro.navegador}): ${erro.mensagem}`);
  json(res, 200, { ok: true });
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
    enviarEmail(u.email, `Criar nova senha — ${APP_NOME}`, {
      titulo: 'Criar uma nova senha',
      paragrafos: [
        `Recebemos um pedido para criar uma nova senha para ${u.email} na Central de Gestão ${APP_NOME}.`,
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
    participantes: q.all.all().map((p) => paraUsuario(u, lerParticipante(p))),
    sorteios: q.draws.all().map((p) => paraUsuario(u, lerParticipante(p))),
    datas: q.datas.all(),
    eventos: q.eventos.all(),
    campos: q.campos.all().map(lerCampo),
    diagnostico,
    hoje: hoje(),
  });
});

rota('GET', '/api/admin/participantes.csv', (req, res) => {
  const u = exigirUsuario(req, res, 'admin');
  if (!u) return;
  const params = new URL(req.url, 'http://localhost').searchParams;
  const dia = dataParam(params.get('data'));
  const evento = String(params.get('evento') || '');
  const rows = (dia ? q.byDate.all(dia) : evento ? q.byEvento.all(evento) : q.all.all()).map(lerParticipante);
  const extras = q.campos.all().filter((c) => c.sistema !== 'evento');
  const lines = [['codigo', 'nome', 'cpf', 'telefone', 'email', 'data_cadastro', 'presencas', ...extras.map((c) => c.rotulo),
    'criado_em_utc', 'aceita_ofertas', 'aceite_em_utc', 'versao_aviso'].map(csvCell).join(',')];
  for (const r of rows) {
    const presencas = r.presencas.map((x) => `${diaBr(x.dia)}${x.evento ? ' - ' + x.evento : ''}`).join(' | ');
    const resp = extras.map((c) => { const v = r.respostas[c.id]; return v === true ? 'sim' : v ?? ''; });
    lines.push([codigo(r.id), r.nome, r.cpf, r.telefone, r.email, r.data_cadastro, presencas, ...resp, r.criado_em,
      r.aceita_marketing ? 'sim' : 'nao', r.aceite_em, r.termos_versao].map(csvCell).join(','));
  }
  const filtro = dia ? 'dia ' + diaBr(dia) : evento ? 'evento ' + evento : 'todos os eventos';
  registrar(u, 'cadastros.exportados', `${rows.length} cadastros · ${filtro}`);
  send(res, 200, '﻿' + lines.join('\r\n'), {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="participantes${dia ? '-' + dia : evento ? '-evento' : ''}.csv"`,
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
  json(res, 200, paraUsuario(u, lerParticipante(q.byId.get(id))));
});

rota('DELETE', '/api/admin/participantes/:id', (req, res, { id }) => {
  const u = exigirUsuario(req, res, 'admin');
  if (!u) return;
  const p = q.byId.get(id);
  if (!p) return json(res, 404, { erro: 'Cadastro não encontrado.' });
  transacao(() => {
    q.deleteDrawsOf.run(id);
    q.deletePresencasOf.run(id);
    q.delete.run(id);
  });
  registrar(u, 'cadastro.excluido', `${codigo(id)} · ${p.nome} · CPF ${p.cpf} · cadastro de ${diaBr(p.data_cadastro)}`);
  json(res, 200, { ok: true });
});

// --- sorteio ---

rota('POST', '/api/admin/sortear', async (req, res) => {
  const u = exigirUsuario(req, res);
  if (!u) return;
  const body = await readJson(req).catch(() => ({}));
  // Com "data" ou "evento", só concorre quem esteve naquele dia ou evento.
  const dia = dataParam(body.data);
  const evento = typeof body.evento === 'string' ? body.evento : '';
  const pool = dia ? q.eligibleByDate.all(dia) : evento ? q.eligibleByEvento.all(evento) : q.eligible.all();
  if (!pool.length) return json(res, 409, { erro: 'Não há participantes elegíveis para sortear.' });
  // crypto.randomInt usa um gerador criptograficamente seguro e sem viés.
  const winnerId = pool[crypto.randomInt(pool.length)].id;
  q.insertDraw.run(winnerId);
  const vencedor = lerParticipante(q.byId.get(winnerId));
  registrar(u, 'sorteio', `${codigo(winnerId)} · ${vencedor.nome} · ${dia ? 'dia ' + diaBr(dia) : evento || 'todos os eventos'} · ${pool.length} concorrendo`);
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
      q.updateUser.run(d.nome, d.email, d.papel, d.ativo, d.notif, id);
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
const SLUGS_RESERVADOS = new Set(['admin', 'login', 'sorteio', 'brindes', 'cadastro', 'api', 'vendor', 'privacidade']);

function normalizeLink(body, { principal }) {
  const slug = principal ? '' : String(body.slug || '').trim().toLowerCase().replace(/^\/+/, '');
  const destino = String(body.destino || '').trim();
  const descricao = String(body.descricao || '').trim().slice(0, 120) || null;
  const errors = [];
  if (!principal) {
    if (!/^[a-z0-9-]{1,40}$/.test(slug)) errors.push('O endereço do link deve ter só letras minúsculas, números e hífen.');
    else if (SLUGS_RESERVADOS.has(slug)) errors.push(`"/${slug}" já é usado pelo sistema. Escolha outro endereço.`);
  }
  // Só destinos internos ("/brindes") ou páginas http(s); nada de javascript: e afins.
  let ok = /^\/[^/\\]/.test(destino) && destino.length <= 500;
  if (!ok) {
    try {
      const u = new URL(destino);
      ok = (u.protocol === 'https:' || u.protocol === 'http:') && destino.length <= 2000;
    } catch {}
  }
  if (!ok) errors.push('Informe um destino válido, começando com https:// (ou /brindes para o formulário).');
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
  const link = q.linkById.get(id);
  if (!link) return json(res, 404, { erro: 'Link não encontrado.' });
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
    navegadores: q.acessosPorNavegador.all(id, inicio),
    // Para links que levam ao formulário: quantos cadastros houve no período (conversão).
    cadastros: link.destino === FORMULARIO
      ? Object.fromEntries(q.cadastrosPorDia.all(inicio).map((r) => [r.dia, r.total]))
      : null,
    hoje: hoje(),
  });
});

// Pré-visualizações de link (WhatsApp, redes sociais) e robôs não contam como acesso.
const ROBO = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|slack|discord|skype|preview|curl|wget|python-requests|go-http-client/i;

// Navegador ou app em que o link abriu. Apps como Instagram e Facebook abrem links no próprio
// navegador interno e se identificam no User-Agent.
function navegador(ua) {
  if (/instagram/i.test(ua)) return 'instagram';
  if (/FBAN|FBAV|FB_IAB/.test(ua)) return 'facebook';
  if (/tiktok|musical_ly|bytedance/i.test(ua)) return 'tiktok';
  if (/SamsungBrowser/.test(ua)) return 'samsung';
  if (/EdgA?\/|EdgiOS/.test(ua)) return 'edge';
  if (/OPR\/|Opera/.test(ua)) return 'opera';
  if (/FxiOS|Firefox\//.test(ua)) return 'firefox';
  if (/CriOS|Chrome\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'outro';
}

function dispositivo(ua) {
  if (/iphone|ipad|ipod/i.test(ua)) return 'iphone';
  if (/android/i.test(ua)) return 'android';
  if (/windows|macintosh|linux|cros/i.test(ua)) return 'computador';
  return 'outro';
}

// Acrescenta etiquetas UTM para o Google Analytics / Instagram saberem que o acesso veio do QR Code.
// Destinos internos (/brindes) e endereços que já têm UTM ficam como estão.
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
    q.insertAcesso.run(link.id, hoje(agora), horaLocal(agora), dispositivo(ua), navegador(ua));
  }
  const destino = link.utm ? comUtm(link.destino, link.slug) : link.destino;
  send(res, 302, '', { Location: destino, 'Cache-Control': 'no-store' });
}

// --- backups ---

rota('GET', '/api/admin/backups', (req, res) => {
  if (!exigirUsuario(req, res, 'admin')) return;
  json(res, 200, { pasta: path.resolve(BACKUP_DIR), manter: BACKUP_MANTER, horas: BACKUP_HORAS, backups: listarBackups() });
});

rota('POST', '/api/admin/backups', (req, res) => {
  const u = exigirUsuario(req, res, 'admin');
  if (!u) return;
  const nome = fazerBackup('manual');
  registrar(u, 'backup.criado', nome);
  json(res, 201, { nome });
});

const backupDoPedido = (req) => {
  const nome = new URL(req.url, 'http://localhost').searchParams.get('nome') || '';
  if (!/^sorteio-[\w-]+\.db$/.test(nome)) return null;
  const arquivo = path.join(BACKUP_DIR, nome);
  return fs.existsSync(arquivo) ? { nome, arquivo } : null;
};

rota('GET', '/api/admin/backups/baixar', (req, res) => {
  const u = exigirUsuario(req, res, 'admin');
  if (!u) return;
  const b = backupDoPedido(req);
  if (!b) return json(res, 404, { erro: 'Backup não encontrado.' });
  registrar(u, 'backup.baixado', b.nome);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${b.nome}"`,
    'Content-Length': fs.statSync(b.arquivo).size,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(b.arquivo).pipe(res);
});

rota('POST', '/api/admin/backups/restaurar', (req, res) => {
  const u = exigirUsuario(req, res, 'admin');
  if (!u) return;
  const b = backupDoPedido(req);
  if (!b) return json(res, 404, { erro: 'Backup não encontrado.' });
  try {
    const r = restaurarBackup(b.arquivo);
    registrar(null, 'backup.restaurado', `${b.nome} restaurado por ${u.nome} · ${r.participantes} cadastros, ${r.usuarios} usuários · cópia anterior: ${r.seguranca}`);
    json(res, 200, r);
  } catch (e) {
    json(res, 422, { erro: e.message });
  }
});

// Restaurar a partir de um arquivo .db enviado do computador (ex.: um backup baixado antes).
rota('POST', '/api/admin/backups/enviar', async (req, res) => {
  const u = exigirUsuario(req, res, 'admin');
  if (!u) return;
  const LIMITE = 200 * 1024 * 1024;
  const temp = path.join(BACKUP_DIR, `envio-${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  try {
    await new Promise((resolve, reject) => {
      let tamanho = 0;
      const out = fs.createWriteStream(temp);
      req.on('data', (c) => {
        tamanho += c.length;
        if (tamanho > LIMITE) {
          req.destroy();
          reject(new Error('Arquivo grande demais.'));
        }
      });
      req.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      req.on('error', reject);
    });
    const r = restaurarBackup(temp);
    registrar(null, 'backup.restaurado', `Arquivo enviado por ${u.nome} · ${r.participantes} cadastros, ${r.usuarios} usuários · cópia anterior: ${r.seguranca}`);
    json(res, 200, r);
  } catch (e) {
    json(res, 422, { erro: e.message });
  } finally {
    fs.rmSync(temp, { force: true });
  }
});

// --- eventos (opções do campo Evento do formulário) ---

rota('GET', '/api/admin/eventos', (req, res) => {
  if (!exigirUsuario(req, res, 'admin')) return;
  const c = lerCampo(q.campoEvento.get());
  json(res, 200, { eventos: c.opcoes, ativo: !!c.ativo, presentes: Object.fromEntries(q.eventos.all().map((e) => [e.evento, e.total])) });
});

// Recebe a lista inteira: { eventos: [{ nome, antigo }], ativo }. "antigo" é o nome anterior de um
// evento renomeado: as presenças já registradas passam para o novo nome.
rota('PUT', '/api/admin/eventos', async (req, res) => {
  const u = exigirUsuario(req, res, 'admin');
  if (!u) return;
  const body = await readJson(req).catch(() => ({}));
  const itens = (Array.isArray(body.eventos) ? body.eventos : [])
    .map((e) => ({ nome: String(e?.nome || '').trim().replace(/\s+/g, ' ').slice(0, 120), antigo: typeof e?.antigo === 'string' ? e.antigo : null }))
    .filter((e) => e.nome);
  const nomes = [...new Set(itens.map((e) => e.nome))];
  if (nomes.length !== itens.length) return json(res, 422, { erro: 'Há eventos com o mesmo nome.' });
  const ativo = body.ativo !== false;
  if (ativo && !nomes.length) return json(res, 422, { erro: 'Cadastre ao menos um evento.' });
  if (nomes.length > 50) return json(res, 422, { erro: 'São no máximo 50 eventos.' });
  const anterior = lerCampo(q.campoEvento.get()).opcoes;
  const renomeados = itens.filter((e) => e.antigo && e.antigo !== e.nome && !nomes.includes(e.antigo));
  transacao(() => {
    for (const e of renomeados) {
      q.renomearEvento.run(e.nome, e.antigo);
      q.apagarEventoAntigo.run(e.antigo); // sobra só se a pessoa já tinha o novo nome no mesmo dia
    }
    q.updateEventos.run(JSON.stringify(nomes), ativo ? 1 : 0);
  });
  const mudancas = [
    ...nomes.filter((n) => !anterior.includes(n) && !renomeados.some((e) => e.nome === n)).map((n) => `adicionou "${n}"`),
    ...renomeados.map((e) => `renomeou "${e.antigo}" para "${e.nome}"`),
    ...anterior.filter((n) => !nomes.includes(n) && !renomeados.some((e) => e.antigo === n)).map((n) => `removeu "${n}"`),
  ];
  registrar(u, 'eventos.editados', (mudancas.join('; ') || 'mudou a ordem') + (ativo ? '' : ' · campo escondido do formulário'));
  json(res, 200, { ok: true });
});

rota('GET', '/api/admin/auditoria', (req, res) => {
  if (!exigirUsuario(req, res, 'admin')) return;
  json(res, 200, q.logs.all());
});

// --- páginas ---

rota('GET', '/', (req, res) => redirecionarLink(req, res, q.linkBySlug.get('') || { id: 0, slug: '', destino: FORMULARIO }));

rota('GET', FORMULARIO, (req, res) => serveFile(res, 'index.html'));
// Endereço antigo do formulário: continua funcionando (links e QR Codes já compartilhados).
for (const antigo of ['/sorteio', '/brindes']) {
  rota('GET', antigo, (req, res) => redirect(res, FORMULARIO + (new URL(req.url, 'http://localhost').search)));
}

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
    const ext = path.extname(file);
    // Páginas sempre conferem com o servidor antes de usar a cópia guardada (evita formulário antigo).
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
    send(res, 200, buf, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
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
    if (pathname === '/index.html') return redirect(res, FORMULARIO);
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
// Versões anteriores criavam um cadastro por CPF por dia. Junta esses cadastros no mais antigo (que
// mantém o código), levando as presenças e os sorteios, para cada pessoa ter um cadastro só.
function unificarDuplicados() {
  const grupos = db.prepare('SELECT cpf, MIN(id) AS fica FROM participantes GROUP BY cpf HAVING COUNT(*) > 1').all();
  if (!grupos.length) return;
  const juntados = [];
  transacao(() => {
    for (const { cpf, fica } of grupos) {
      for (const { id } of db.prepare('SELECT id FROM participantes WHERE cpf = ? AND id <> ?').all(cpf, fica)) {
        db.prepare('INSERT OR IGNORE INTO presencas (participante_id, dia, evento, criado_em) SELECT ?, dia, evento, criado_em FROM presencas WHERE participante_id = ?').run(fica, id);
        db.prepare('UPDATE sorteios SET participante_id = ? WHERE participante_id = ?').run(fica, id);
        q.deletePresencasOf.run(id);
        q.delete.run(id);
        juntados.push(`${codigo(id)} → ${codigo(fica)}`);
      }
    }
  });
  registrar(null, 'cadastros.unificados', `Cadastros do mesmo CPF juntados: ${juntados.join(', ')}`);
  console.log(`Cadastros duplicados juntados: ${juntados.join(', ')}`);
}

// Versão anterior permitia criar campos extras; uma cópia do campo Evento criada assim é juntada no
// campo Evento de verdade (opções e respostas), e os demais campos extras saem do formulário.
function unificarCamposExtras() {
  const extras = q.campos.all().filter((c) => !c.sistema).map(lerCampo);
  if (!extras.length) return;
  transacao(() => {
    let opcoes = lerCampo(q.campoEvento.get()).opcoes;
    for (const c of extras) {
      if (c.tipo === 'selecao' && /evento/i.test(c.rotulo)) {
        opcoes = [...new Set([...opcoes, ...c.opcoes])];
        const comResposta = db.prepare("SELECT id, respostas FROM participantes WHERE respostas <> '{}'").all()
          .filter((p) => JSON.parse(p.respostas)[c.id] != null);
        for (const p of comResposta) {
          const r = JSON.parse(p.respostas);
          const ev = r[c.id];
          delete r[c.id];
          q.updateRespostas.run(JSON.stringify(r), p.id);
          db.prepare("UPDATE OR IGNORE presencas SET evento = ? WHERE participante_id = ? AND evento = ''").run(ev, p.id);
        }
      }
      db.prepare('DELETE FROM campos WHERE id = ?').run(c.id);
    }
    db.prepare("UPDATE campos SET opcoes = ? WHERE sistema = 'evento'").run(JSON.stringify(opcoes));
  });
  registrar(null, 'campos.unificados', `Campos extras juntados ao campo Evento: ${extras.map((c) => c.rotulo).join(', ')}`);
}

function aplicarRetencao() {
  if (!RETENCAO_DIAS) return;
  const limite = hoje(new Date(Date.now() - RETENCAO_DIAS * 86400000));
  const ids = q.expiredIds.all(limite).map((r) => r.id);
  if (!ids.length) return;
  transacao(() => {
    for (const id of ids) {
      q.deleteDrawsOf.run(id);
      q.deletePresencasOf.run(id);
      q.delete.run(id);
    }
  });
  registrar(null, 'retencao', `${ids.length} cadastros anteriores a ${diaBr(limite)} apagados (retenção de ${RETENCAO_DIAS} dias)`);
  console.log(`Retenção: ${ids.length} cadastros antigos apagados.`);
}
unificarDuplicados();
unificarCamposExtras();
aplicarRetencao();
setInterval(aplicarRetencao, 6 * 60 * 60 * 1000).unref();
backupAutomatico();
setInterval(backupAutomatico, BACKUP_HORAS * 60 * 60 * 1000).unref();

criarPrimeiroAdmin().then(() => {
  server.listen(PORT, () => {
    console.log(`Sorteio "${EVENT_NAME}" rodando em http://localhost:${PORT}`);
    console.log(`Painel: http://localhost:${PORT}/admin`);
    const total = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    console.log(`Banco de dados: ${path.resolve(DB_PATH)} (${total('usuarios')} usuários, ${total('participantes')} cadastros)`);
    console.log(mailer.configurado()
      ? `E-mail: ligado (${process.env.SMTP_HOST}, enviando como ${process.env.SMTP_FROM || process.env.SMTP_USER})`
      : 'E-mail: desligado (defina SMTP_HOST, SMTP_USER e SMTP_PASS). Convites, recuperação de senha e avisos de cadastro não são enviados.');
    // Na Hostinger (e em outros serviços que publicam a partir do Git) a pasta do app é recriada a
    // cada publicação: um banco guardado dentro dela some junto, com cadastros e usuários.
    const rel = path.relative(__dirname, path.resolve(DB_PATH));
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && !process.env.DB_PATH_DENTRO_DO_APP_OK) {
      console.warn('[ATENÇÃO] O banco de dados está dentro da pasta do app. Se a hospedagem recria essa pasta a cada');
      console.warn('          publicação, cadastros e usuários são apagados. Defina DB_PATH fora dela,');
      console.warn('          por exemplo /home/SEU_USUARIO/sorteio-data/sorteio.db (no Docker, use o volume).');
    }
  });
});
