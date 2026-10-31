# NOMEIA

Nomeações e votações de cargos em **reuniões presenciais**. Três telas sincronizadas em tempo real:

| Tela | Arquivo | Quem usa |
| --- | --- | --- |
| Painel da mesa | `admin.html` | Administrador (protegido por segredo + sessão) |
| Projeção | `apresentacao.html?m=<id>` | Projetor/telão |
| Votação | `votar.html?m=<id>` | Celulares dos participantes (navegador ou PWA instalada) |
| Entrada | `index.html` | Direciona para a reunião vinculada, código do cartão ou administração |

Stack: HTML5 + CSS3 + JavaScript vanilla (ES modules) no navegador; Node.js puro (`http`) no servidor;
WebSocket com [`ws`](https://www.npmjs.com/package/ws); QR Code com [`qrcode`](https://www.npmjs.com/package/qrcode);
persistência em arquivos JSON. Sem frameworks, sem bundler, sem banco de dados.

> **Importante:** o NOMEIA é uma ferramenta de apoio a reuniões. **Não é um sistema de eleição formal**
> e não oferece as garantias de uma urna auditada. Leia [Riscos e limites](#riscos-e-limites).

---

## Instalação no VS Code

1. Instale o **Node.js 20.10+** (testado no Node 24) — <https://nodejs.org>.
2. Abra a pasta do projeto no VS Code (`Arquivo > Abrir Pasta...`).
3. Terminal integrado (`` Ctrl+` ``):
   ```bash
   npm install
   cp .env.example .env        # no PowerShell: Copy-Item .env.example .env
   ```
4. Edite `.env` e defina `ADMIN_SECRET` (mínimo 16 caracteres):
   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```
   Em desenvolvimento, se ficar vazio, o servidor gera um segredo e o grava em `data/admin-secret.txt`
   (o segredo nunca é impresso no log).
5. Rode e depure pelo painel **Executar e Depurar** (`F5`) com as configurações
   `NOMEIA: servidor` e `NOMEIA: testes` (`.vscode/launch.json`).

## Execução local

```bash
npm start        # produção/local
npm run dev      # reinicia ao salvar (node --watch)
npm test         # testes automatizados (Node test runner)
npm run simulate # simula votos concorrentes em um servidor temporário
npm run icons    # regenera os ícones PNG da PWA
```

Acesse `http://localhost:3000/admin.html`, entre com o segredo e:

1. **Crie a reunião** (nome e total previsto de participantes). O sistema gera ID, link público e link de apresentação.
2. **Emita as credenciais** (uma por participante presente) e **imprima os cartões** — cada cartão tem QR pessoal e código.
3. Abra o **link da apresentação** no projetor. O QR exibido ali é o link público (acompanhamento, sem voto).
4. **Crie o cargo** e adicione os nomes propostos. Celulares e projetor atualizam na hora; o voto fica bloqueado.
5. **ABRIR VOTAÇÃO** → todos os celulares conectados mostram as opções (+ **Abstenção**).
6. Acompanhe a participação (votos confirmados, faltantes, abstenções, válidos).
7. **ENCERRAR VOTAÇÃO** → resultado calculado, gravado e selado com SHA-256. **Publicar resultados** se o modo exigir.
8. **PRÓXIMO CARGO** → novo formulário; o anterior vai para o **Histórico** (detalhes + CSV).
9. **Encerrar reunião** → somente leitura (consultas e exportações continuam disponíveis).

## Acesso por celulares na mesma rede

1. Computador e celulares no **mesmo Wi-Fi**. O servidor escuta em `0.0.0.0:3000` (`HOST`/`PORT` no `.env`).
2. Descubra o IP do computador (`ipconfig` no Windows, `ip a`/`ifconfig` no Linux/macOS), ex.: `192.168.0.10`.
3. Libere a porta no firewall. Windows (PowerShell como administrador):
   ```powershell
   New-NetFirewallRule -DisplayName "NOMEIA 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
   ```
4. Se o administrador abrir o painel em `localhost`, os links e QR Codes já usam automaticamente o IP da rede local.
   Para fixar um endereço, defina `PUBLIC_ORIGIN` (ex.: `http://192.168.0.10:3000`).
5. Redes de convidados/corporativas com **isolamento de clientes** bloqueiam o acesso entre aparelhos — use um roteador próprio.

**PWA na rede local:** navegadores só registram service worker e permitem "instalar" em **HTTPS** (ou `localhost`).
Em `http://192.168.x.x` a votação funciona normalmente pelo navegador, mas sem instalação. Para instalar na rede local,
gere um certificado confiável com [mkcert](https://github.com/FiloSottile/mkcert) e configure `TLS_KEY_FILE` e
`TLS_CERT_FILE` (o servidor passa a servir HTTPS/WSS direto). A CA do mkcert precisa ser instalada nos celulares.

## HTTPS em produção (proxy reverso)

Use um servidor com **disco persistente** (VPS, máquina local, container com volume). **Não use hospedagem serverless**
com sistema de arquivos efêmero: os JSON de `data/` seriam perdidos.

`.env` de produção:
```ini
NODE_ENV=production
ADMIN_SECRET=<segredo forte>
HOST=127.0.0.1
PORT=3000
PUBLIC_ORIGIN=https://nomeia.suaorg.org.br
TRUST_PROXY=1
DATA_DIR=/var/lib/nomeia
```

**Caddy** (certificado automático, WebSocket incluso):
```caddy
nomeia.suaorg.org.br {
    reverse_proxy 127.0.0.1:3000
}
```

**nginx**:
```nginx
server {
    listen 443 ssl http2;
    server_name nomeia.suaorg.org.br;
    ssl_certificate     /etc/letsencrypt/live/nomeia.suaorg.org.br/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nomeia.suaorg.org.br/privkey.pem;
    client_max_body_size 11m;               # importação de JSON (limite do app: 10 MB)

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # WebSocket (WSS)
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;   # sobrescreve, não acumula
        proxy_read_timeout 120s;
    }
}
server { listen 80; server_name nomeia.suaorg.org.br; return 301 https://$host$request_uri; }
```

Com `NODE_ENV=production` o cookie de sessão vira `__Host-nomeia_sid; Secure; HttpOnly; SameSite=Strict` e o
servidor envia HSTS. Use um gerenciador de processos (systemd, pm2, Docker `restart: unless-stopped`).
`SIGINT`/`SIGTERM` aguardam as gravações pendentes antes de encerrar.

## Arquitetura

```
nomeacao/
├── server.js               # ponto de entrada (carrega .env, inicia, encerra com segurança)
├── src/
│   ├── app.js              # servidor HTTP, roteador, endpoints e regras de negócio
│   ├── realtime.js         # hub WebSocket (salas por reunião, heartbeat, snapshots)
│   ├── store.js            # persistência JSON: fila serializada, escrita atômica, ledger, backups, import/export
│   ├── domain.js           # modelo, estados, validação, apuração, snapshots público/admin
│   ├── security.js         # tokens, códigos, hashes, comparação em tempo constante, rate limit, sessões
│   ├── http.js             # cabeçalhos de segurança, corpo limitado, estáticos, origem, IP
│   ├── exporter.js         # CSV seguro e QR Code
│   └── config.js           # .env e configuração
├── public/                 # ÚNICO diretório servido
│   ├── index.html  votar.html  apresentacao.html  admin.html  offline.html
│   ├── css/style.css
│   ├── js/common.js  votar.js  apresentacao.js  admin.js  index.js  offline.js
│   ├── sw.js  manifest.webmanifest  icons/
├── data/                   # criado em execução (fora de public/, ignorado pelo git)
│   ├── meetings/<id>.json  # estado de cada reunião
│   ├── ledger/<id>.jsonl   # registro imutável (append-only, encadeado por hash)
│   └── backups/<id>/*.json # backups versionados
├── test/                   # testes automatizados (node --test)
└── scripts/                # simulate-votes.js, gen-icons.js
```

### Estados

- Cargo: `draft` → `discussing` → `voting_open` → `closed` (sem volta; `closed` é imutável).
- Reunião: `active` → `archived` (somente leitura).
- Fase exibida (`phase`): `draft` (sem cargo), `discussing`, `voting_open`, `closed`, `archived`.
- Apenas um cargo pode estar em `discussing`/`voting_open` por vez. Cargos podem ser preparados como rascunho
  (`start: false`) e não aparecem ao público.

Todas as entidades têm IDs aleatórios (`m_`, `o_`, `c_`, `p_` + 12 caracteres), `createdAt`/`updatedAt`; cargos têm
`openedAt`/`closedAt`; a reunião tem `schemaVersion` e `version` (incrementada a cada alteração).
Nomes podem se repetir entre cargos — os votos são sempre por ID de candidato dentro do cargo.

### Contratos HTTP

Respostas em JSON. Erros: `{"error": {"code": "...", "message": "..."}}`.
Requisições que alteram estado (`POST/PATCH/DELETE`) exigem `Content-Type: application/json` e o cabeçalho
`X-Nomeia: 1` (proteção CSRF); `Origin`, se presente, deve ser a do próprio servidor.

**Público**

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/api/health` | Saúde |
| GET | `/api/meetings/:id` | Snapshot público (sem credenciais, sem quem votou, sem apuração não liberada) |
| GET | `/api/meetings/:id/link` | Link público (IP da rede quando acessado por localhost) |
| GET | `/api/meetings/:id/qr.svg` | QR do link público |
| POST | `/api/credentials/check` | `Authorization: Bearer <token ou código>` → `{meetingId, meetingName, participant:{label, revoked}, votedOfficeIds}` |
| POST | `/api/meetings/:id/votes` | `Authorization: Bearer <credencial>`, corpo `{officeId, choice}` (`choice` = ID do candidato ou `"abstain"`) → `201` |

Códigos de erro do voto: `credential_required` (401), `invalid_credential`/`credential_revoked` (403),
`voting_not_open`/`voting_closed`/`already_voted`/`meeting_archived` (409), `invalid_choice` (400), `rate_limited` (429).

**Administrativo** (cookie de sessão; prefixo `/api/admin`)

| Método | Rota | Descrição |
| --- | --- | --- |
| POST | `/login` `{secret}` · `/logout` · GET `/session` | Sessão |
| GET/POST | `/meetings` | Listar / criar `{name, expectedParticipants}` |
| GET/PATCH | `/meetings/:id` | Snapshot admin / editar nome e previsto |
| GET | `/meetings/:id/links` | Links público e de apresentação + QR |
| POST | `/meetings/:id/credentials` `{count, labelPrefix}` | Emite credenciais (tokens/códigos só aparecem nesta resposta) |
| POST | `/meetings/:id/participants/:pid/reissue` · `/revoke` | Reemitir (invalida a antiga) / revogar |
| POST | `/meetings/:id/offices` `{title, description, resultsMode, start}` | Cria cargo (`start` padrão `true`) |
| PATCH | `/meetings/:id/offices/:oid` | Editar título/descrição (antes da votação) e `resultsMode` |
| POST | `/meetings/:id/offices/:oid/start` · `/open` · `/close` · `/publish` | Transições |
| POST/PATCH/DELETE | `/meetings/:id/offices/:oid/candidates[/:cid]` | Nomes propostos (só em `draft`/`discussing`) |
| POST | `/meetings/:id/archive` | Encerrar reunião |
| POST/GET | `/meetings/:id/backup` · `/backups` | Criar / listar backups |
| GET | `/meetings/:id/export.json` · `/export.csv` · `/offices/:oid/export.csv` | Exportações |
| POST | `/import` | Importar exportação/backup (até 10 MB) |

`resultsMode`: `on_publish` (oculto até a mesa publicar — padrão), `on_close` (publica ao encerrar), `live` (parcial visível durante a votação).

### Contrato WebSocket

`GET /ws?meeting=<id>` (público) ou `/ws?meeting=<id>&role=admin` (exige cookie de sessão).

- Servidor → cliente: `{type, meetingId, version, at, state}` — `state` é o **snapshot completo** (público ou admin).
  Tipos: `snapshot` (ao conectar/`sync`), `meeting_updated`, `office_updated`, `candidates_updated`, `vote_opened`,
  `vote_accepted`, `turnout_updated`, `vote_closed`, `results_published`, `next_office`, `meeting_closed`.
- Cliente → servidor: `{"type":"ping"}` (responde `pong`) e `{"type":"sync"}` (reenvia snapshot).
- Fechamentos: `4401` (sem sessão admin), `4404` (reunião inexistente).
- Como toda mensagem traz o estado completo e a `version`, mensagens duplicadas são idempotentes e antigas são descartadas.
  O cliente reconecta com backoff exponencial, envia heartbeat a cada 20 s, ressincroniza ao voltar para o primeiro
  plano (`visibilitychange`, `online`, `pageshow`) e o servidor encerra conexões mortas a cada 25 s.
  Várias abas: cada uma tem sua conexão; o voto em uma aba é avisado às outras via `BroadcastChannel`, e o servidor
  recusa repetição de qualquer forma.

## Credenciais e antiduplicidade

- O **link/QR público** mostra a reunião, mas **não permite votar**. Não há emissão de credencial por clique público.
- A mesa emite **credenciais individuais**: token de 256 bits (no QR/link do cartão, dentro do fragmento `#t=`, que não
  é enviado ao servidor em navegação nem aparece em logs) e um **código** de 12 caracteres (~59 bits) para digitação.
- O servidor guarda **apenas hashes SHA-256**; a verificação usa comparação em tempo constante.
  Tentativas inválidas têm rate limit por IP.
- A credencial vale para a reunião inteira: **exatamente um voto por cargo**.
- Na primeira entrada o participante escolhe **"Salvar neste aparelho"** (localStorage) ou **"Usar só nesta sessão"**.
- **Troca de aparelho:** digite o código do cartão no novo aparelho — mesmo participante, nenhum voto extra.
  **Cartão perdido:** a mesa usa **Reemitir**; o cartão antigo deixa de funcionar e os votos já dados continuam contando uma vez.
- **Revogar** impede votos futuros daquela credencial (votos já registrados permanecem).
- Voto atômico: cada reunião tem uma fila serializada. Fase, credencial, cargo, duplicidade e opção são validados
  **dentro** da fila sobre o estado confirmado, e o sucesso só é respondido **depois** da gravação durável
  (arquivo temporário + `fsync` + `rename`). Duas requisições simultâneas da mesma credencial geram um único registro.
- Encerramento × voto no último instante: ambos passam pela mesma fila; vale a ordem de processamento do servidor.
  Votos que chegam depois recebem `voting_closed` e a tela informa que **não** foram registrados.

> **Credenciais podem ser compartilhadas.** Quem tem o cartão (ou foto dele) vota. Sem conferência de presença na
> entrega dos cartões, **não há garantia de uma pessoa física por voto**.

## Persistência, backup e restauração

- `data/meetings/<id>.json` é reescrito atomicamente a cada alteração, sempre validado antes de gravar.
  No Windows, o `rename` é repetido em caso de bloqueio transitório (antivírus/OneDrive).
- Ao iniciar, arquivos `.tmp` (escritas interrompidas, nunca confirmadas) são descartados; se o arquivo principal estiver
  corrompido, o servidor recupera automaticamente do **backup mais recente válido**.
- `data/ledger/<id>.jsonl`: entradas append-only, encadeadas por hash, para cada cargo encerrado, publicação e encerramento.
- Backups automáticos ao encerrar cada cargo, ao encerrar a reunião e ao importar; manuais pelo botão
  **Criar backup no servidor**. São mantidos os `BACKUP_KEEP` mais recentes (padrão 100) — o mais novo, com a última
  votação, nunca é apagado.
- **Exportar JSON** (backup completo: reunião + ledger, sem tokens em claro) e **CSV** (resultados, `;` e vírgula
  decimal para Excel pt-BR, com proteção contra injeção de fórmulas).
- **Importar**: no painel inicial. Valida estrutura, soma da apuração, hash de cada resultado encerrado e cadeia do ledger.
  IDs, histórico e credenciais (hashes) são preservados. **Nunca sobrescreve** uma reunião existente (`409`).
- **Restaurar manualmente:** pare o servidor, copie o backup desejado de `data/backups/<id>/` e importe-o pelo painel
  (em uma pasta `data/` sem aquela reunião), ou extraia o campo `meeting` para `data/meetings/<id>.json`.
- Faça cópias periódicas da pasta `data/` inteira para outro disco.

## PWA

- Instalável (manifest, ícones 192/512/maskable, apple-touch-icon, service worker) em HTTPS.
- A página de votação vincula o manifest à reunião (`/manifest.webmanifest?m=<id>` → `start_url` da reunião).
  Ao abrir o app instalado, ele vai direto à tela da reunião, **busca o estado atual** e fica em espera até a próxima votação.
- O service worker guarda apenas a casca (HTML/CSS/JS/ícones) com estratégia rede-primeiro e mostra `offline.html`
  sem conexão. **Não armazena `/api`, não enfileira votos e não faz envio em segundo plano.**
- **Sem notificações push e sem sincronização com o app totalmente fechado:** a atualização acontece enquanto a
  tela está aberta, e ao reabrir.
- **iOS:** o app instalado na tela inicial tem armazenamento separado do Safari. Depois de instalar, digite o código do
  cartão uma vez dentro do app (não gera voto extra).

## Segurança implementada

Segredo admin só no servidor (comparação em tempo constante); sessão em cookie `HttpOnly` + `SameSite=Strict`
(+ `Secure`/`__Host-` em produção); CSRF por cabeçalho próprio + checagem de `Origin`/`Sec-Fetch-Site`; sem CORS;
CSP sem `unsafe-inline`, `nosniff`, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, HSTS em HTTPS;
somente `public/` é servido (bloqueio de `..`, arquivos ocultos e extensões desconhecidas); limites de corpo (16 KB;
10 MB na importação), de payload WebSocket (1 KB) e de quantidade (credenciais, cargos, candidatos); textos
normalizados e sem caracteres de controle; front-end usa apenas `textContent` (sem `innerHTML`); rate limiting por IP
(global, login, voto, credenciais inválidas, conexões WS); logs só com método, caminho e status — nunca tokens,
cabeçalhos ou corpos; erros internos sem detalhes para o cliente.

## Testes

```bash
npm test
```

36 testes em `test/` cobrem, entre outros: atualização de nomes chegando a dois celulares; voto bloqueado na discussão;
25 votos simultâneos da mesma credencial (inclusive token + código) → 1 registro; recarregar não permite novo voto;
voto nos cargos A e B; link público sem credencial não vota; corrida voto × encerramento; persistência após reinício;
recuperação de arquivo corrompido; abstenção × não votou (inclusive no CSV); percentuais, empate e zero votos;
imutabilidade de resultados fechados; acesso público sem poderes administrativos; CSRF, travessia de diretório, XSS,
rate limit; snapshot ao reconectar (PWA reaberta); exportar/reimportar preservando IDs; rejeição de importação adulterada.

Simulação de carga:
```bash
npm run simulate -- --voters 300 --dup 4
# contra um servidor em execução (lembre-se do rate limit de votos por IP):
node scripts/simulate-votes.js --base http://localhost:3000 --secret SEU_SEGREDO --voters 25 --dup 3
```

## Riscos e limites

- **Não é eleição formal.** Não há auditoria independente, assinatura de eleitor nem verificação individual do voto.
- **Uma pessoa, um voto não é garantido:** credenciais podem ser emprestadas, fotografadas ou repassadas. A garantia
  depende da entrega controlada dos cartões (conferência de presença) e da reemissão/revogação quando necessário.
- **Sigilo limitado:** o servidor guarda separadamente *quem votou* (lista de IDs, em ordem aleatória) e a *apuração
  agregada* (contadores), nunca o par credencial→escolha. Porém, quem administra o servidor ou observa o painel
  em tempo real (lista de quem votou + apuração parcial) pode correlacionar votos por tempo, sobretudo em grupos
  pequenos ou no modo de resultados ao vivo. O operador do servidor e quem acessa a pasta `data/` são partes confiáveis.
- **O administrador é confiável:** ele emite credenciais e poderia emitir cartões extras. O total de credenciais
  ativas é exibido para conferência pública com o número de presentes.
- Sessões administrativas ficam em memória: reiniciar o servidor exige novo login (dados não são afetados).
- Escala pensada para reuniões presenciais (dezenas a poucas centenas de participantes por instância).
  Cada voto grava o arquivo da reunião com `fsync`; em SSD comum, centenas de votos por segundo.
- Rate limit por IP: atrás de NAT/proxy sem `TRUST_PROXY=1`, todos parecem o mesmo IP. Ajuste os limites em
  `src/config.js` se a rede concentrar muitos aparelhos em um IP.
- Conexão: o voto só vale com confirmação do servidor. Sem rede no momento do encerramento, o voto não é registrado.
- Disco cheio ou sem permissão: a gravação falha e o voto é recusado (nunca confirmado sem persistir).
