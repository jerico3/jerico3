# Cadastro para sorteio (via QR Code)

Landing page mobile para cadastrar participantes do sorteio de brindes da importadora. Cada pessoa
recebe na hora um **código de participação** (`VW-0001`, `VW-0002`, …), que é o ID do cadastro. Um
painel administrativo, com login por usuário, mostra a lista, permite corrigir e excluir cadastros,
exporta CSV, gera o QR Code da página e faz o sorteio pelo código, **separado por dia de evento**: cada
sorteio considera só quem se cadastrou naquele dia.

O QR Code é **dinâmico**: ele aponta para um link do próprio site, e o destino desse link pode ser
trocado no painel a qualquer momento (o formulário hoje, o Instagram amanhã) sem reimprimir nada.

## Imagem de fundo

`public/fundo.webp` é o fundo da tela do formulário (interior do carro com a logo da importadora,
exportado do Figma). Para trocar, substitua o arquivo mantendo a logo na mesma posição, ou ajuste o
`padding` de `.tela-form` em `public/index.html`.

Sem dependências externas: usa apenas Node.js (>= 22.13) com o SQLite nativo (`node:sqlite`).

## Como rodar

```bash
ADMIN_EMAIL=voce@empresa.com ADMIN_PASSWORD=uma-senha-forte EVENT_NAME="Importadora" npm start
```

- Link principal (o do QR Code): `http://localhost:3000/` → por padrão leva ao formulário
- Formulário do sorteio: `http://localhost:3000/sorteio`
- Painel: `http://localhost:3000/admin` (redireciona para o login em `/login`)

Na primeira vez que o app sobe com o banco vazio, ele cria um **administrador** com `ADMIN_EMAIL` e
`ADMIN_PASSWORD`. Depois disso essas variáveis não são mais usadas: os demais usuários são criados pelo
próprio painel, e cada um pode trocar a senha em **Alterar senha**.

Para desenvolvimento: `npm run dev` (entra com `admin@sorteio.local` / `admin`, recarrega ao salvar).

### Variáveis de ambiente

| Variável         | Padrão              | Descrição                                            |
| ---------------- | ------------------- | ---------------------------------------------------- |
| `ADMIN_EMAIL`    | `admin@sorteio.local` | E-mail do primeiro administrador (só no 1º uso).   |
| `ADMIN_PASSWORD` | _(vazio)_           | Senha do primeiro administrador (só no 1º uso).      |
| `EVENT_NAME`     | `Sorteio`           | Nome na aba do navegador, no painel e no QR Code.    |
| `PORT`           | `3000`              | Porta HTTP.                                          |
| `DB_PATH`        | `./data/sorteio.db` | Arquivo do banco SQLite.                             |
| `CODE_PREFIX`    | `VW-`               | Prefixo do código de participação.                   |
| `TIMEZONE`       | `America/Sao_Paulo` | Fuso usado para definir o dia do cadastro.           |

## Funcionalidades

**Formulário do sorteio (`/sorteio`)**
- Layout do Figma: fundo com a logo da importadora e a frase "Preencha seu cadastro e concorra a brindes exclusivos".
- Nome, telefone (com máscara), CPF (validado pelos dígitos verificadores) e e-mail, todos
  obrigatórios, além do aceite de uso dos dados (LGPD).
- Ao clicar em **Enviar**, a pessoa vê a tela "Seu código de participação" com o código.
- A data do cadastro é registrada (no fuso de Brasília).
- **Um cadastro por CPF por dia**: se a pessoa tentar de novo no mesmo dia, vê o mesmo código; em
  outro dia (outro evento), recebe um código novo, que vale para o sorteio daquele dia. O telefone
  pode se repetir (ex.: pessoas da mesma família).
- O código fica salvo no navegador até o fim do dia: reabrir a página ou escanear o QR de novo no
  mesmo dia mostra o código.
- Proteções básicas contra abuso: campo isca anti-bot e limite de tentativas por IP.

**Painel (`/admin`)**
- **Login** com e-mail e senha (senhas guardadas com hash `scrypt`, sessão de 12 horas em cookie
  `HttpOnly`, bloqueio de 15 minutos após 10 tentativas erradas).
- **Perfis**: *Administrador* faz tudo; *Operador* vê e edita cadastros, baixa o CSV e faz sorteios,
  mas não exclui cadastros, não reinicia o histórico e não gerencia usuários.
- **Cadastros**: editar (nome, telefone, CPF, e-mail) e excluir. O dia do cadastro não muda.
- **Usuários**: criar, editar, redefinir senha, desativar e excluir (sempre fica ao menos um
  administrador ativo). Desativar ou redefinir a senha derruba as sessões abertas da pessoa.
- **Atividade**: registro de quem entrou, sorteou, editou ou excluiu, com data e detalhes.
- **Dia do evento**: escolha a data e o painel passa a mostrar só os cadastros daquele dia
  (contagem, lista, CSV e sorteio). Abre no dia de hoje.
- Total de participantes, lista com busca (código, nome, CPF ou telefone) e exportação CSV (abre direto no Excel).
- **Links e QR Code**: o link principal (`/`, o do QR impresso) e links extras (`/instagram`,
  `/whatsapp`…), cada um com destino editável, contagem de acessos e QR Code para baixar ou imprimir.
  O redirecionamento é temporário (302, sem cache), então a troca de destino vale na hora, inclusive
  para quem já escaneou antes. Só administradores criam e editam links. Confira o domínio público
  no campo da aba antes de imprimir.
- **Sortear**: escolhe um código aleatório entre os cadastros do dia escolhido ainda não sorteados
  (gerador criptográfico `crypto.randomInt`), com animação de roleta. Os sorteados ficam no
  histórico e não concorrem de novo; **Reiniciar histórico** (só administradores) limpa o histórico.

## Publicação

O QR Code precisa apontar para um endereço público com HTTPS. Qualquer serviço que rode Node.js
serve (Render, Railway, Fly.io, uma VPS…). Garanta que o arquivo do banco (`DB_PATH`) fique em um
**disco persistente**, senão os cadastros se perdem quando o serviço reinicia.

Com Docker:

```bash
docker build -t sorteio .
docker run -p 3000:3000 -v sorteio-data:/app/data \
  -e ADMIN_EMAIL=voce@empresa.com -e ADMIN_PASSWORD=uma-senha-forte -e EVENT_NAME="Importadora" sorteio
```

Depois de publicado, abra `/admin` → **Links e QR Code**, confira o domínio público e imprima.
