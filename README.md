# Cadastro para sorteio (via QR Code)

Landing page mobile para cadastrar participantes de um sorteio. Cada pessoa recebe na hora o
**número da sorte**, que é o próprio ID do cadastro (`#0001`, `#0002`, …). Um painel administrativo
mostra a lista, exporta CSV, gera o QR Code da página e faz o sorteio pelo ID.

Sem dependências externas: usa apenas Node.js (>= 22.13) com o SQLite nativo (`node:sqlite`).

## Como rodar

```bash
ADMIN_PASSWORD=minha-senha EVENT_NAME="Sorteio de Natal" npm start
```

- Página de cadastro: `http://localhost:3000/`
- Painel admin: `http://localhost:3000/admin` (usuário: qualquer um; senha: `ADMIN_PASSWORD`)

Para desenvolvimento: `npm run dev` (senha `admin`, recarrega ao salvar).

### Variáveis de ambiente

| Variável         | Padrão              | Descrição                                            |
| ---------------- | ------------------- | ---------------------------------------------------- |
| `ADMIN_PASSWORD` | _(vazio)_           | Senha do painel. Sem ela, o `/admin` fica bloqueado. |
| `EVENT_NAME`     | `Sorteio`           | Nome exibido na página, no painel e no QR Code.      |
| `PORT`           | `3000`              | Porta HTTP.                                          |
| `DB_PATH`        | `./data/sorteio.db` | Arquivo do banco SQLite.                             |

## Funcionalidades

**Página de cadastro (`/`)**
- Nome, CPF (validado pelos dígitos verificadores), WhatsApp/telefone (com máscara), e-mail opcional
  e aceite de uso dos dados (LGPD).
- Mostra o número da sorte logo após o cadastro.
- Cada CPF se cadastra uma vez só: se repetir, a pessoa vê o mesmo número de antes. O telefone pode
  se repetir (ex.: pessoas da mesma família).
- O número fica salvo no navegador, então reabrir a página ou escanear o QR de novo mostra o número.
- Proteções básicas contra abuso: campo isca anti-bot e limite de tentativas por IP.

**Painel (`/admin`)**
- Total de participantes, lista com busca (nome, CPF, telefone ou número) e exportação CSV (abre direto no Excel).
- QR Code da página, com download da imagem e versão para impressão (botão **Imprimir**).
  Confira se o endereço no campo é o endereço público antes de imprimir.
- **Sortear agora**: escolhe um ID aleatório entre os participantes ainda não sorteados
  (gerador criptográfico `crypto.randomInt`), com animação de roleta. Os sorteados ficam no
  histórico e não concorrem de novo; **Reiniciar** limpa o histórico.

## Publicação

O QR Code precisa apontar para um endereço público com HTTPS. Qualquer serviço que rode Node.js
serve (Render, Railway, Fly.io, uma VPS…). Garanta que o arquivo do banco (`DB_PATH`) fique em um
**disco persistente**, senão os cadastros se perdem quando o serviço reinicia.

Com Docker:

```bash
docker build -t sorteio .
docker run -p 3000:3000 -v sorteio-data:/app/data \
  -e ADMIN_PASSWORD=minha-senha -e EVENT_NAME="Sorteio de Natal" sorteio
```

Depois de publicado, abra `/admin`, confira o endereço no campo do QR Code e imprima.
