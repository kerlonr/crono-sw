# Cronômetro Sync

Cronômetros sincronizados em tempo real com painel de admin, tela pública de viewer e visão geral das sessões online.
Uma sessão comporta vários cronômetros ao mesmo tempo — por exemplo uma aula de 80 horas regressiva, o tempo decorrido
progressivo e um intervalo de 25 minutos — todos controlados na mesma tela.

## Visão Geral

O projeto permite:

- criar uma sessão com quantos cronômetros forem necessários (até 12)
- fazer um cronômetro ganhar tempo automaticamente conforme outro avança
- iniciar a contagem de um ponto qualquer, e não do zero
- dar um título a cada cronômetro e escolher entre contagem regressiva ou progressiva
- controlar cada cronômetro individualmente ou todos de uma vez pela tela de admin
- eleger um cronômetro como destaque, que aparece grande no viewer
- reordenar os cronômetros do board
- compartilhar um link de viewer para acompanhar as contagens em tempo real
- salvar modelos de cronômetro no navegador para remontar o board em um clique
- acompanhar e finalizar sessões ativas em um painel geral

## Stack

- Node.js
- Express
- Socket.IO
- Helmet
- express-rate-limit
- HTML, CSS e JavaScript sem framework

## Estrutura

```text
.
|-- public/
|   |-- index.html
|   |-- admin.html
|   |-- overview.html
|   |-- viewer.html
|   `-- assets/
|       |-- audio/
|       |   `-- trompeta.mp3
|       |-- css/
|       |   |-- index.css
|       |   |-- admin.css
|       |   |-- overview.css
|       |   `-- viewer.css
|       `-- js/
|           |-- crono-utils.js
|           |-- index.js
|           |-- admin.js
|           |-- finish-sound.js
|           |-- overview.js
|           `-- viewer.js
|-- scripts/
|   |-- deployer.js
|   `-- webhook-deploy.sh
|-- test/
|   |-- security.test.js
|   |-- sessions.test.js
|   `-- timers.test.js
|-- src/
|   |-- config.js
|   |-- deploy-client.js
|   |-- logger.js
|   |-- security.js
|   |-- sessions.js
|   `-- timers.js
|-- server.js
|-- Dockerfile
|-- docker-compose.yml
|-- .env.example
|-- .gitignore
|-- .dockerignore
|-- package.json
`-- package-lock.json
```

## Organização de Responsabilidades

### Backend

- `server.js`: configura Express, segurança, rotas HTTP, Socket.IO e CSP.
- `src/config.js`: centraliza variáveis de ambiente e valores padrão.
- `src/sessions.js`: guarda sessões em memória, a lista de cronômetros de cada uma e o tick compartilhado.
- `src/timers.js`: modelo de um cronômetro isolado (contagem, start/pause/reset, sanitização).
- `src/security.js`: valida origem, tokens e assinatura do webhook.
- `src/logger.js`: registra acessos e eventos do app.
- `src/deploy-client.js`: dispara o serviço opcional de deploy.

### Frontend

- `public/index.html` + `assets/js/index.js`: cria uma nova sessão.
- `public/admin.html` + `assets/js/admin.js`: controla tempo, presets, fullscreen e link do viewer.
- `public/viewer.html` + `assets/js/viewer.js`: mostra a contagem sincronizada sem controles.
- `public/overview.html` + `assets/js/overview.js`: lista sessões ativas e permite finalizar sessões.
- `assets/js/finish-sound.js`: encapsula o som final do cronômetro.
- `assets/js/crono-utils.js`: utilidades compartilhadas (`window.CronoUtils`) de formatação de tempo, sanitização e validação, usadas por admin, viewer e overview.

### CSS

Cada tela possui um CSS próprio para evitar acoplamento visual excessivo:

- `index.css`: tela inicial.
- `admin.css`: painel de controle e drawer mobile.
- `viewer.css`: tela pública de contagem.
- `overview.css`: painel geral de sessões.

O padrão visual atual é dark glass: fundos escuros, bordas translúcidas, blur e acentos em verde/azul.

## Requisitos

- Node.js 20+
- npm

## Rodando Localmente

1. Instale as dependencias:

```bash
npm ci
```

2. Crie um arquivo `.env` a partir do exemplo:

```bash
cp .env.example .env
```

No Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

3. Inicie o servidor:

```bash
npm start
```

4. Acesse:

```text
http://localhost:3000
```

## Usando com Docker

Build da imagem:

```bash
docker build -t cronometro-sync .
```

Subindo com Compose:

```bash
docker compose up --build
```

Por padrão, o `docker-compose.yml` expõe a aplicação apenas em:

```text
http://127.0.0.1:3000
```

## Fluxo de Uso

1. Abra a página inicial.
2. Clique em `Criar cronômetro`.
3. Você será redirecionado para a URL de admin da sessão, que já nasce com um cronômetro.
4. Use `+ Cronômetro` para adicionar os que faltarem, dê um título a cada um e escolha o modo em `Ajustar`.
5. Marque com a estrela qual cronômetro vai em destaque no viewer.
6. Use o link de viewer exibido no painel para compartilhar a visualização.
7. Abra `/overview` para ver e finalizar sessões ativas.

### Cronômetros

Cada cronômetro tem título, modo e tempo total:

| Modo | Mostra na tela | O total significa |
|---|---|---|
| Regressivo | quanto falta | a duração |
| Progressivo | quanto já passou | a meta |

Os dois modos terminam no mesmo ponto (quando o decorrido atinge o total) e usam a mesma escala de cores:
verde no começo, amarelo abaixo de 40%, vermelho abaixo de 20% e piscando abaixo de 10%.

### Ponto de partida

O mesmo campo serve aos dois modos, mudando de nome conforme o sentido: **Já decorrido** no progressivo
(quanto já correu) e **Já consumido** no regressivo (quanto já foi gasto). Há também `ou começou às`, que
calcula o valor a partir de um horário — se o horário ainda não chegou hoje, entende-se que foi ontem.

O ponto fica guardado à parte do decorrido, então `Reset` volta para ele, não para zero. Informar consumo
**não** descarta o tempo ganho por regra; só o `Reset` faz isso.

Para não precisar calcular na mão, o campo **Começou em** aceita data, hora, minuto e segundo e deduz
sozinho quanto já correu — `Sincronizar e iniciar` aplica e dá Start num clique. A data importa porque uma
contagem de 80 horas atravessa dias: só o horário não diria se foi hoje, ontem ou anteontem. Vale igual
para progressivo e regressivo, já que nos dois o que conta é quanto tempo passou desde o início. O campo
abre preenchido com o instante que a contagem atual implica, servindo também de conferência.

### Acesso do admin

O token no hash do link continua sendo a credencial. Usuário e senha são **opcionais** e servem para
recuperá-lo: define-se um par em Configurações → Acesso do admin, dentro do painel; quem
abrir `/admin/:id` sem token vê um formulário de login. `/overview` traz um botão **Admin** em cada card,
que é o caminho de volta quando o link se perde.

Como é tratado:

- a senha nunca é armazenada — fica só o `scrypt` com sal aleatório por senha (`src/auth.js`), sem
  dependência nova nem compilação nativa
- comparação com `timingSafeEqual`, para o tempo de resposta não denunciar acertos parciais
- `POST /api/session/:id/login` é limitado a 15 tentativas por IP a cada 15 minutos
- a resposta é idêntica para senha errada, usuário errado, sessão sem login e sessão inexistente, para não
  virar um mapa de quais sessões têm credencial
- `/api/sessions/active` expõe apenas `hasAuth`, nunca usuário, sal ou hash
- o formulário usa `method="post"`, então nem um envio nativo (JS quebrado) leva a senha para a URL

### Reconexão

Ao reconectar, o Socket.IO cria um socket **novo** no servidor — sem sala e sem papel de admin. Por isso
admin e viewer reentram na sessão a cada evento `connect`, o que cobre a primeira conexão e todas as
reconexões. Sem isso a tela congelava no último valor recebido e os controles paravam de responder em
silêncio, dando a impressão de que a sessão havia caído (ela seguia viva no servidor).

Uma queda mostra um aviso discreto de "Reconectando..." em vez de derrubar a tela, e um `not_found` logo
após reinício do servidor é tentado de novo até 6 vezes antes de virar erro — costuma ser corrida com a
restauração do snapshot.

### Persistência

As sessões são gravadas em disco a cada 5 segundos e no desligamento (`STATE_FILE`, `STATE_SAVE_SECONDS`),
e recarregadas no boot. Cronômetros que estavam rodando voltam rodando com o `startTime` original, então o
tempo em que o processo ficou fora conta — a aula não parou porque o servidor reiniciou. O link do admin
continua valendo, porque o token é preservado.

### Ganhar tempo automaticamente

Um cronômetro pode somar tempo conforme outro avança: *a cada 1h de Aula, somar 5 min ao Break*. O tempo
ganho fica em `bonusMs`, separado da duração configurada, e a tela mostra os dois ("25 min + 15 min ganhos").

O ganho é recalculado do decorrido da fonte a cada tick, então tick perdido, atraso ou reconexão não
duplicam nem pulam uma concessão — um salto de 4 horas concede as 4 de uma vez. Um intervalo que já tinha
zerado volta a ficar disponível, pausado, ao ganhar tempo novo. Zerar a fonte descarta o que ela concedeu,
para o bônus de uma rodada não somar com o da seguinte.

O board tem ainda `Iniciar todos`, `Pausar todos` e `Zerar todos`. Os cronômetros são independentes entre si:
começar o intervalo não pausa os demais.

### Modelos

Um modelo guarda título, tempo e modo, fica no `localStorage` do navegador e vale para qualquer sessão.
Clicar em um modelo na barra superior cria o cronômetro já configurado. Modelos antigos salvos como presets
por sessão são migrados automaticamente na primeira abertura.

Observação:

- a URL de admin inclui um token no hash para autenticar a sessão de controle
- a URL de viewer não inclui permissão de admin
- o arquivo de som final deve ficar em `public/assets/audio/trompeta.mp3`

## Variáveis de Ambiente

As variáveis atuais são:

| Variável | Obrigatória | Descrição |
|---|---|---|
| `PORT` | não | Porta HTTP da aplicação |
| `NODE_ENV` | não | Ambiente de execução |
| `APP_ORIGIN` | recomendado | Origem permitida para conexões e uso do app |
| `HOST_REPO_PATH` | sim, se auto-deploy ativado | Caminho absoluto do repo no host |
| `ENABLE_WEBHOOK` | não | Ativa o endpoint `/webhook` |
| `WEBHOOK_SECRET` | sim, se webhook ativado | Segredo para validar assinatura do webhook |
| `WEBHOOK_DEPLOY_BRANCH` | não | Branch aceito para o auto-deploy |
| `DEPLOYER_TIMEOUT_MS` | não | Timeout para disparar o serviço de deploy |
| `SESSION_TTL_MINUTES` | não | Tempo de vida das sessões em memória (padrão 1440, ou seja 24h) |
| `SESSION_CLEANUP_MINUTES` | não | Intervalo de limpeza das sessões expiradas |
| `STATE_FILE` | não | Arquivo do snapshot das sessões (padrão `logs/sessions.json`) |
| `STATE_SAVE_SECONDS` | não | Intervalo entre gravações do snapshot (padrão 5) |
| `TRUST_PROXY` | não | Ativa `trust proxy` no Express |

## Eventos de Socket

Todos os eventos de escrita exigem que o socket tenha entrado na sessão com o papel `admin`.

| Evento | Direção | Descrição |
|---|---|---|
| `session:join` | cliente → servidor | Entra na sessão como `admin` (com token) ou `viewer` |
| `session:state` | servidor → cliente | Estado completo: lista de cronômetros e id do destaque |
| `session:closed` | servidor → cliente | A sessão foi encerrada |
| `timer:add` | admin → servidor | Cria um cronômetro; responde com o id ou `limit_reached` |
| `timer:remove` | admin → servidor | Remove um cronômetro |
| `timer:update` | admin → servidor | Altera título, modo, tempo total, ponto de partida e/ou regra de ganho |
| `timer:setPrimary` | admin → servidor | Define o destaque do viewer |
| `timer:move` | admin → servidor | Move um cronômetro uma posição no board |
| `timer:start` / `timer:pause` / `timer:reset` | admin → servidor | Controla um cronômetro pelo id |
| `timers:bulk` | admin → servidor | Aplica `start`, `pause` ou `reset` em todos |
| `session:setAuth` | admin → servidor | Define ou remove usuário e senha da sessão |
| `timer:tick` | servidor → cliente | Formato antigo (um cronômetro), mantido por compatibilidade |

Limites aplicados no servidor: até 12 cronômetros por sessão, título de até 24 caracteres e tempo total
entre 1 segundo e 100 horas. A regra de ganho exige intervalo de no mínimo 1 minuto, recusa auto-referência
e nunca deixa o total efetivo passar do máximo.

## Endpoints Principais

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/` | Página inicial |
| `POST` | `/api/session/new` | Cria uma nova sessão (aceita `username`/`password` opcionais, sem uso na interface) |
| `POST` | `/api/session/:id/login` | Recupera o token de admin com usuário e senha |
| `GET` | `/api/sessions/active` | Lista sessões ativas |
| `DELETE` | `/api/sessions/:id` | Finaliza uma sessão |
| `GET` | `/admin/:id` | Painel de admin |
| `GET` | `/overview` | Painel com todos os cronômetros ativos |
| `GET` | `/view/:id` | Tela de viewer |
| `GET` | `/health` | Healthcheck simples |
| `POST` | `/webhook` | Endpoint opcional de webhook |

## Validação Local

```bash
npm run check
npm test
npm audit --audit-level=moderate
```

Os testes usam o runner nativo do Node (`node --test`), sem dependências
extras, e cobrem `src/security.js` e `src/sessions.js`.

## Segurança Atual

O projeto já inclui algumas medidas de endurecimento:

- token de admin por sessão
- validação de `sessionId`, token e payloads recebidos
- `Helmet` com CSP e headers de segurança
- rate limit global, para criação de sessão e para webhook
- validação de assinatura no webhook
- restrição de origem para conexões do Socket.IO
- expiração automática de sessões em memória
- limite máximo de tempo configurável no servidor
- frontend sem `onclick` inline nem scripts embutidos, o que permite CSP mais forte
- serviço principal do app rodando como usuário não-root no Compose
- `docker-compose.yml` com `read_only`, `tmpfs`, `cap_drop` e `no-new-privileges`

## Limitações Atuais

Alguns pontos importantes para considerar antes de produção mais séria:

- as sessões ficam em memória, com snapshot em disco; um disco perdido leva as sessões junto
- uma sessão sem nenhum cliente conectado expira pelo TTL; com alguém conectado, ela é mantida viva
- os modelos de cronômetro ficam em `localStorage` no navegador do admin
- não existe banco de dados
- não existe painel de usuários nem autenticação tradicional
- o deploy automatico continua exigindo um sidecar com acesso ao Docker socket do host

## Boas Práticas para Este Repo

- não commitar `.env`
- não remover `.gitignore` nem `.dockerignore`
- prefira `npm ci` em vez de `npm install`
- use `APP_ORIGIN` corretamente no ambiente onde for publicar
- deixe `ENABLE_WEBHOOK=false` se você não estiver usando webhook

## Próximos Passos Recomendados

- mover sessão para Redis ou banco
- ampliar a cobertura de testes (eventos de socket e fluxo de deploy)
- criar pipeline de deploy fora da aplicação
- adicionar observabilidade e logs estruturados
