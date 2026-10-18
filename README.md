# Cadastro para sorteio (via QR Code)

Landing page mobile para cadastrar participantes do sorteio de brindes da importadora. Cada pessoa
recebe na hora um **código**, que é o próprio ID do cadastro (`0001`, `0002`, …). Um painel
administrativo mostra a lista, exporta CSV, gera o QR Code da página e faz o sorteio pelo código.

## Logo

Coloque a logo da importadora em `public/logo.png` (PNG com fundo transparente fica melhor, já que o
topo da página é azul-escuro). Sem esse arquivo, a página mostra o `EVENT_NAME` no lugar da logo.

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
- Logo no topo e a frase "Preencha seu cadastro e concorra a brindes exclusivos".
- Nome, telefone (com máscara), CPF (validado pelos dígitos verificadores) e e-mail, todos
  obrigatórios, além do aceite de uso dos dados (LGPD).
- Ao clicar em **Enviar**, a pessoa recebe o seu código.
- Cada CPF se cadastra uma vez só: se repetir, a pessoa vê o mesmo código de antes. O telefone pode
  se repetir (ex.: pessoas da mesma família).
- O código fica salvo no navegador, então reabrir a página ou escanear o QR de novo mostra o código.
- Proteções básicas contra abuso: campo isca anti-bot e limite de tentativas por IP.

**Painel (`/admin`)**
- Total de participantes, lista com busca (código, nome, CPF ou telefone) e exportação CSV (abre direto no Excel).
- QR Code da página, com download da imagem e versão para impressão (botão **Imprimir**).
  Confira se o endereço no campo é o endereço público antes de imprimir.
- **Sortear agora**: escolhe um código aleatório entre os participantes ainda não sorteados
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
