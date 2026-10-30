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

Sem dependências externas: usa apenas Node.js (>= 22.13) com o SQLite nativo (`node:sqlite`). O envio
de e-mail (`mailer.js`) e a verificação em duas etapas (`totp.js`) também usam só módulos nativos.

## Como rodar

```bash
ADMIN_EMAIL=voce@empresa.com ADMIN_PASSWORD=uma-senha-forte EVENT_NAME="Importadora" npm start
```

- Link principal (o do QR Code): `http://localhost:3000/` → por padrão leva ao formulário
- Formulário de cadastro: `http://localhost:3000/cadastro` (os endereços antigos `/sorteio` e `/brindes` redirecionam para ele)
- Painel: `http://localhost:3000/admin` (redireciona para o login em `/login`)

Na primeira vez que o app sobe com o banco vazio, ele cria um **administrador** com `ADMIN_EMAIL` e
`ADMIN_PASSWORD`. Depois disso essas variáveis não são mais usadas: os demais usuários são convidados
pelo painel (recebem um e-mail para confirmar o cadastro e criar a senha). No primeiro login, todo
usuário configura a **verificação em duas etapas** com um app autenticador.

Para desenvolvimento: `npm run dev` (entra com `admin@sorteio.local` / `admin` e configura o app
autenticador no primeiro login; recarrega ao salvar).

### Variáveis de ambiente

| Variável         | Padrão              | Descrição                                            |
| ---------------- | ------------------- | ---------------------------------------------------- |
| `PUBLIC_URL`     | _(vazio)_           | Domínio público (ex.: `https://importadoravw.link`), usado nos links e QR Codes do painel. |
| `ADMIN_EMAIL`    | `admin@sorteio.local` | E-mail do primeiro administrador (só no 1º uso).   |
| `ADMIN_PASSWORD` | _(vazio)_           | Senha do primeiro administrador (só no 1º uso).      |
| `EVENT_NAME`     | `Sorteio`           | Nome na aba do navegador, no painel e no QR Code.    |
| `PORT`           | `3000`              | Porta HTTP.                                          |
| `DB_PATH`        | `./data/sorteio.db` | Arquivo do banco SQLite.                             |
| `CODE_PREFIX`    | `VW-`               | Prefixo do código de participação.                   |
| `TIMEZONE`       | `America/Sao_Paulo` | Fuso usado para definir o dia do cadastro.           |
| `CONTROLADOR_NOME` | `EVENT_NAME`      | Razão social exibida no Aviso de Privacidade.        |
| `CONTROLADOR_CNPJ` | _(vazio)_         | CNPJ exibido no Aviso de Privacidade.                |
| `CONTATO_PRIVACIDADE` | _(vazio)_      | E-mail para pedidos dos titulares (LGPD, art. 18).   |
| `RETENCAO_DIAS`  | `0` (desligado)     | Apaga automaticamente cadastros com mais de N dias.  |
| `SMTP_HOST`      | _(vazio)_           | Servidor de e-mail. Hostinger: `smtp.hostinger.com`. |
| `SMTP_PORT`      | `465`               | 465 = SSL; 587 = STARTTLS.                           |
| `SMTP_USER`      | _(vazio)_           | Conta de e-mail que envia (ex.: `nao-responda@seudominio`). |
| `SMTP_PASS`      | _(vazio)_           | Senha dessa conta de e-mail.                         |
| `SMTP_FROM`      | `SMTP_USER`         | Remetente, se for diferente do usuário.              |
| `SMTP_NOME`      | `EVENT_NAME`        | Nome do remetente.                                   |
| `APP_NOME`       | `Importadora Link`  | Nome do sistema no login, no painel e nos e-mails da equipe. |
| `INSTAGRAM_URL`  | `https://www.instagram.com/importadoravolkswagen/` | Instagram divulgado na tela do código e no comprovante (vazio = esconde). |
| `MARCA_NOME`     | `Importadora Volkswagen` | Marca mostrada ao participante (tela do código e comprovante por e-mail). |
| `TOTP_EMISSOR`   | `APP_NOME`          | Nome da conta que aparece no app autenticador.       |
| `DOIS_FATORES`   | _(ligado)_          | `desligado` = login só com e-mail e senha. Não apaga nada: ao religar, quem já tinha o app configurado volta a usá-lo. |
| `BACKUP_DIR`     | pasta `backups` ao lado do banco | Onde ficam as cópias de segurança.      |
| `BACKUP_HORAS`   | `6`                 | Intervalo entre backups automáticos (também faz um ao iniciar). |
| `BACKUP_MANTER`  | `28`                | Quantos backups automáticos guardar.                 |

Sem `SMTP_*`, o painel continua funcionando: o convite vira um link para o administrador copiar e
enviar, e "Esqueci minha senha" avisa que a recuperação por e-mail não está configurada. Os links dos
e-mails usam `PUBLIC_URL`, que precisa estar definido para a recuperação de senha funcionar.

## Funcionalidades

**Formulário de cadastro (`/cadastro`)**
- Layout do Figma: fundo com a logo da importadora e a frase "Preencha seu cadastro e concorra a brindes exclusivos".
- Nome, telefone (com máscara), CPF (validado pelos dígitos verificadores) e e-mail, todos
  obrigatórios, além do aceite de uso dos dados (LGPD).
- Campos obrigatórios marcados com asterisco. Ao enviar com algo faltando ou errado, cada campo com
  problema fica destacado em vermelho com a mensagem logo abaixo (o servidor confere de novo e devolve
  o erro de cada campo). 
- Ao clicar em **Enviar**, a pessoa vê o comprovante na tela ("Você está concorrendo a brindes!",
  o código, como será o contato e o convite para seguir o Instagram) e recebe o mesmo comprovante por
  e-mail, com a marca `MARCA_NOME` (sem o nome do sistema interno).
- A data do cadastro é registrada (no fuso de Brasília).
- **Um cadastro por CPF, válido para todos os eventos.** Quem vai a outro evento envia o formulário
  de novo: o sistema registra a **presença** naquele dia e mostra o mesmo código, sem duplicar o
  cadastro nem reenviar o e-mail. O telefone precisa ser o mesmo do cadastro. Cadastros duplicados de
  versões anteriores (mesmo CPF em dias diferentes) são juntados no mais antigo ao iniciar.
- O código fica salvo no navegador até o fim do dia: reabrir a página ou escanear o QR de novo no
  mesmo dia mostra o código.
- Proteções básicas contra abuso: campo isca anti-bot e limite de tentativas recusadas por IP (cadastros
  que deram certo não contam, porque no evento muita gente usa a mesma rede).
- Se alguém tentar um CPF já cadastrado no dia com outro telefone, o sistema não revela o nome nem o
  código de quem se cadastrou (evita descobrir dados de terceiros pelo CPF).

**LGPD**
- Aceite **obrigatório** do Aviso de Privacidade (`/privacidade`), validado no navegador e no servidor.
- Aceite de **ofertas separado e opcional** (consentimento específico, art. 8º §4º).
- Cada cadastro guarda a prova do consentimento: data/hora, versão do aviso (`TERMOS_VERSAO` em
  `server.js`; mude-a quando o texto mudar) e se aceitou ofertas. Aparece no painel e no CSV.
- Minimização: operadores veem o CPF mascarado (`***.456.789-**`) e não exportam CSV.
- Retenção configurável (`RETENCAO_DIAS`), com registro na aba Atividade.
- Atendimento aos titulares: buscar pelo CPF, corrigir ou excluir o cadastro no painel.
- O Aviso de Privacidade é um modelo: **revise com o jurídico** antes de usar.

**Notificações por e-mail** (precisa do `SMTP_*`)
- Quem se cadastra recebe o **comprovante de participação**: código, nome, dia do evento e como
  funciona o sorteio. A tela mostra para qual e-mail (mascarado) ele foi enviado.
- Administradores recebem um e-mail a cada novo cadastro (nome, código e CPF mascarado). Cada um pode
  desligar em Usuários → Editar → "Receber e-mail a cada novo cadastro".
- Com o painel aberto, um aviso aparece quando chegam cadastros novos.

**Backups do banco** (aba **Backups**, só administradores)
- Backup automático ao iniciar e a cada `BACKUP_HORAS`, mantendo os `BACKUP_MANTER` mais recentes,
  em `BACKUP_DIR` (por padrão ao lado do banco, ou seja, fora da pasta do app se `DB_PATH` estiver
  fora dela). Botão **Fazer backup agora** e **Baixar** para guardar uma cópia no computador.
- **Restaurar** um backup da lista ou **de um arquivo** `.db` baixado antes. Antes de restaurar, o
  sistema faz uma cópia do estado atual ("antes de restaurar"), então dá para desfazer. A numeração
  dos códigos continua de onde o backup parou, o histórico de atividade é somado e todos entram de novo.

**Diagnóstico** (aba Cadastros → "Tentativas de cadastro")
- Desde o último início do app: cadastros concluídos, envios recusados pelo servidor (com o motivo) e
  erros de JavaScript que aconteceram no formulário no celular dos participantes. Os mesmos avisos
  aparecem no log do app (`Cadastro recusado` / `Erro no formulário`).
- Páginas são servidas com `Cache-Control: no-cache` e a API com `no-store`, para ninguém ficar com
  uma cópia antiga do formulário. Se mesmo assim o formulário estiver desatualizado, ele recarrega os
  campos e pede para conferir, sem travar.

**Segurança**
- Cabeçalhos: CSP, `X-Frame-Options: DENY`, HSTS (atrás de HTTPS), `nosniff`, `Referrer-Policy`.
- Limite de tentativas usa o IP anotado pelo proxy (último valor de `X-Forwarded-For`), que o
  cliente não consegue forjar.
- Exportações de CSV ficam registradas na aba Atividade.

**Painel (`/admin`)**
- **Login** com e-mail e senha (senhas guardadas com hash `scrypt`, sessão de 12 horas em cookie
  `HttpOnly`, bloqueio de 15 minutos após 10 tentativas erradas).
- **Verificação em duas etapas obrigatória** (TOTP: Google Authenticator, Microsoft Authenticator,
  Authy). Configurada no primeiro login por QR Code; gera 10 **códigos de recuperação** de uso único.
  Um código não pode ser reaproveitado, e cada tentativa de login aceita no máximo 5 códigos.
- **Convite por e-mail**: o administrador informa nome, e-mail e perfil; a pessoa recebe um link
  (72 h, uso único) para confirmar o cadastro e criar a senha. Até lá a conta fica "convite pendente".
- **Esqueci minha senha**: link por e-mail (1 h, uso único). A resposta é a mesma para e-mails com
  ou sem acesso, a nova senha derruba as sessões abertas e a verificação em duas etapas continua
  valendo. Trocas de senha geram um e-mail de aviso.
- **Redefinir 2 etapas**: o administrador libera um usuário que perdeu ou trocou de celular.
- **Perfis**: *Administrador* faz tudo; *Operador* vê e edita cadastros, baixa o CSV e faz sorteios,
  mas não exclui cadastros, não reinicia o histórico e não gerencia usuários.
- **Cadastros**: editar (nome, telefone, CPF, e-mail) e excluir. O dia do cadastro não muda.
- **Usuários**: criar, editar, redefinir senha, desativar e excluir (sempre fica ao menos um
  administrador ativo). Desativar ou redefinir a senha derruba as sessões abertas da pessoa.
- **Atividade**: registro de quem entrou, sorteou, editou ou excluiu, com data e detalhes.
- **Evento**: abre em "Todos os eventos"; escolha um dia para ver (e sortear) só quem esteve naquele
  evento. A lista mostra os dias de presença de cada pessoa, e o CSV traz a coluna `presencas`.
- Total de participantes, lista com busca (código, nome, CPF ou telefone) e exportação CSV (abre direto no Excel).
- **Eventos** (só administradores): a lista de eventos da caixa **Evento** do formulário (hoje
  XX Fórum de Gastroenterologia Equina e Showroom). Adicionar, renomear, reordenar e remover; renomear
  leva junto as presenças já registradas, e remover só tira o evento da caixa (as presenças ficam).
  A escolha fica registrada na presença: quem vai a outro evento escolhe de novo, com o mesmo código.
- **Mostrar**: filtre o painel por evento ou por dia (contagem, lista, CSV e sorteio).
- **Links e QR Code**: o link principal (`/`, o do QR impresso) e links extras (`/instagram`,
  `/whatsapp`…), cada um com destino editável, contagem de acessos e QR Code para baixar ou imprimir.
  O redirecionamento é temporário (302, sem cache), então a troca de destino vale na hora, inclusive
  para quem já escaneou antes. Só administradores criam e editam links. Confira o domínio público
  no campo da aba antes de imprimir.
  - **QR Code com logo** no centro (`public/qr-logo.png`; com logo o QR usa correção de erro alta),
    para baixar em PNG ou imprimir.
  - **Relatório de acessos** por link: total, hoje, melhor dia, horário de pico, gráfico por dia,
    divisão por aparelho (iPhone, Android, computador) e por navegador ou app (Instagram, Facebook,
    TikTok, Chrome, Safari…). Para o link do formulário, mostra também os cadastros do período e a
    conversão (cadastros ÷ acessos). Pré-visualizações do WhatsApp/redes e robôs não contam. O acesso
    é anônimo: só guarda dia, hora, aparelho e navegador, nada que identifique a pessoa.
  - **UTM automático** (opcional por link): destinos externos recebem
    `utm_source=qrcode&utm_medium=qr&utm_campaign=<link>`, para o Google Analytics mostrar que o
    acesso veio do QR Code. Endereços que já têm UTM não são alterados.
- **Sortear**: escolhe um código aleatório entre os cadastros do dia escolhido ainda não sorteados
  (gerador criptográfico `crypto.randomInt`). O ganhador aparece numa janela por cima do painel
  (que fica desfocado), com o botão **Sortear outro**. Os sorteados ficam no
  histórico e não concorrem de novo; **Reiniciar histórico** (só administradores) limpa o histórico.

## Publicação

O QR Code precisa apontar para um endereço público com HTTPS. Qualquer serviço que rode Node.js
serve (Render, Railway, Fly.io, uma VPS…). Garanta que o arquivo do banco (`DB_PATH`) fique em um
**disco persistente** e **fora da pasta do app**: na Hostinger, cada publicação a partir do GitHub
substitui a pasta do app, e um banco guardado dentro dela é apagado junto. Defina, nas variáveis de
ambiente, algo como `DB_PATH=/home/<usuario>/sorteio-data/sorteio.db`. Ao iniciar, o app mostra no
log o caminho do banco e quantos usuários e cadastros ele tem, e avisa se o banco estiver dentro da
pasta do app.

Com Docker:

```bash
docker build -t sorteio .
docker run -p 3000:3000 -v sorteio-data:/app/data \
  -e PUBLIC_URL=https://importadoravw.link \
  -e ADMIN_EMAIL=voce@empresa.com -e ADMIN_PASSWORD=uma-senha-forte -e EVENT_NAME="Importadora" sorteio
```

Depois de publicado, abra `/admin` → **Links e QR Code**, confira o domínio público e imprima.
