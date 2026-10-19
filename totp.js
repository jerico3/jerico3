'use strict';

// Códigos de verificação em duas etapas (TOTP, RFC 6238), compatíveis com Google Authenticator,
// Microsoft Authenticator, Authy etc. Sem dependências: só o crypto nativo do Node.
const crypto = require('node:crypto');

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIODO = 30;

function base32(buf) {
  let bits = 0, valor = 0, saida = '';
  for (const byte of buf) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      saida += ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) saida += ALFABETO[(valor << (5 - bits)) & 31];
  return saida;
}

function deBase32(texto) {
  let bits = 0, valor = 0;
  const bytes = [];
  for (const ch of texto.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    valor = (valor << 5) | ALFABETO.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function gerarSegredo() {
  return base32(crypto.randomBytes(20));
}

function codigoNoPasso(segredo, passo, digitos = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(passo));
  const h = crypto.createHmac('sha1', deBase32(segredo)).update(msg).digest();
  const desloc = h[h.length - 1] & 0xf;
  const n = (h.readUInt32BE(desloc) & 0x7fffffff) % 10 ** digitos;
  return String(n).padStart(digitos, '0');
}

// Confere o código aceitando 30 s de diferença de relógio para cada lado. Devolve o passo usado
// (para impedir que o mesmo código seja reaproveitado) ou null se não conferir.
function verificar(segredo, entrada, ultimoPasso = -1, agora = Date.now()) {
  const codigo = String(entrada || '').replace(/\D/g, '');
  if (codigo.length !== 6) return null;
  const atual = Math.floor(agora / 1000 / PERIODO);
  for (const passo of [atual, atual - 1, atual + 1]) {
    if (passo <= ultimoPasso) continue;
    if (crypto.timingSafeEqual(Buffer.from(codigoNoPasso(segredo, passo)), Buffer.from(codigo))) return passo;
  }
  return null;
}

// Endereço "otpauth://" que o app autenticador lê pelo QR Code.
function uri(segredo, conta, emissor) {
  const rotulo = encodeURIComponent(`${emissor}:${conta}`);
  return `otpauth://totp/${rotulo}?secret=${segredo}&issuer=${encodeURIComponent(emissor)}&algorithm=SHA1&digits=6&period=${PERIODO}`;
}

module.exports = { gerarSegredo, verificar, uri, codigoNoPasso, base32 };
