'use strict';

// Cliente SMTP mínimo, sem dependências, para enviar os e-mails do painel (convites e recuperação
// de senha). Na Hostinger: SMTP_HOST=smtp.hostinger.com, SMTP_PORT=465 (SSL), usuário = e-mail.
const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const crypto = require('node:crypto');

const cfg = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT) || 465,
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
  fromName: process.env.SMTP_NOME || process.env.APP_NOME || 'Importadora Link',
};
// Porta 465 = SSL desde o início; nas outras, o servidor é atualizado para TLS com STARTTLS.
cfg.secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : cfg.port === 465;

const configurado = () => Boolean(cfg.host && cfg.user && cfg.pass && cfg.from);

// Lê respostas SMTP ("250-..." continua, "250 ..." termina) de um socket.
function leitor(socket) {
  let buffer = '';
  const linhas = [];
  let espera = null;
  let erro = null;
  const tentar = () => {
    if (!espera) return;
    if (erro) {
      const e = espera;
      espera = null;
      return e.reject(erro);
    }
    const fim = linhas.findIndex((l) => /^\d{3}(?: |$)/.test(l));
    if (fim < 0) return;
    const resposta = linhas.splice(0, fim + 1);
    const e = espera;
    espera = null;
    e.resolve({ codigo: Number(resposta[fim].slice(0, 3)), texto: resposta.map((l) => l.slice(4)).join('\n') });
  };
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\r\n')) >= 0) {
      linhas.push(buffer.slice(0, i));
      buffer = buffer.slice(i + 2);
    }
    tentar();
  };
  const onErro = (e) => {
    erro = e;
    tentar();
  };
  socket.on('data', onData);
  socket.on('error', onErro);
  socket.on('close', () => onErro(new Error('Conexão SMTP encerrada')));
  return {
    ler: () => new Promise((resolve, reject) => {
      espera = { resolve, reject };
      tentar();
    }),
    soltar: () => {
      socket.off('data', onData);
      socket.off('error', onErro);
      socket.removeAllListeners('close');
    },
  };
}

const semQuebra = (s) => String(s).replace(/[\r\n]+/g, ' ');
const cabecalhoUtf8 = (s) => `=?UTF-8?B?${Buffer.from(semQuebra(s)).toString('base64')}?=`;
const base64Linhas = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');

function montarMensagem({ para, assunto, texto, html }) {
  const fronteira = `=_${crypto.randomBytes(12).toString('hex')}`;
  const dominio = cfg.from.split('@')[1] || 'localhost';
  return [
    `From: ${cabecalhoUtf8(cfg.fromName)} <${cfg.from}>`,
    `To: <${semQuebra(para)}>`,
    `Subject: ${cabecalhoUtf8(assunto)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${dominio}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${fronteira}"`,
    '',
    `--${fronteira}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Linhas(texto),
    `--${fronteira}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Linhas(html),
    `--${fronteira}--`,
    '',
  ].join('\r\n');
}

async function enviar({ para, assunto, texto, html }) {
  if (!configurado()) throw new Error('E-mail não configurado (SMTP_HOST, SMTP_USER, SMTP_PASS).');
  let socket = cfg.secure
    ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
    : net.connect({ host: cfg.host, port: cfg.port });
  socket.setTimeout(20000, () => socket.destroy(new Error('Tempo esgotado falando com o servidor de e-mail')));
  let conn = leitor(socket);
  const comando = async (linha, esperados) => {
    if (linha !== null) socket.write(linha + '\r\n');
    const r = await conn.ler();
    if (!esperados.includes(r.codigo)) throw new Error(`SMTP respondeu ${r.codigo}: ${r.texto}`);
    return r;
  };
  try {
    await comando(null, [220]);
    const nomeHost = os.hostname() || 'localhost';
    let ehlo = await comando(`EHLO ${nomeHost}`, [250]);
    if (!cfg.secure) {
      if (!/STARTTLS/i.test(ehlo.texto)) throw new Error('O servidor de e-mail não oferece conexão segura (STARTTLS).');
      await comando('STARTTLS', [220]);
      conn.soltar();
      const simples = socket;
      socket = tls.connect({ socket: simples, servername: cfg.host });
      socket.setTimeout(20000, () => socket.destroy(new Error('Tempo esgotado falando com o servidor de e-mail')));
      await new Promise((resolve, reject) => socket.once('secureConnect', resolve).once('error', reject));
      conn = leitor(socket);
      ehlo = await comando(`EHLO ${nomeHost}`, [250]);
    }
    await comando(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString('base64')}`, [235]);
    await comando(`MAIL FROM:<${cfg.from}>`, [250]);
    await comando(`RCPT TO:<${semQuebra(para)}>`, [250, 251]);
    await comando('DATA', [354]);
    // Linhas começando com "." ganham outro "." (regra do SMTP); com base64 isso quase nunca ocorre.
    const corpo = montarMensagem({ para, assunto, texto, html }).replace(/^\./gm, '..');
    await comando(`${corpo}\r\n.`, [250]);
    await comando('QUIT', [221]).catch(() => {});
  } finally {
    socket.destroy();
  }
}

module.exports = { enviar, configurado, montarMensagem };
