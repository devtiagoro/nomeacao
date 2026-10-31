# NOMEIA

Nomeações e votações de cargos em **reuniões presenciais**. Aplicação estática (HTML, CSS e JavaScript puro, PWA instalável) hospedada no **GitHub Pages**, com sincronização em tempo real pelo **Firebase Realtime Database**.

| Tela | Arquivo | Quem usa |
| --- | --- | --- |
| Início | `index.html` | Todos: escolher reunião e abrir votação, apresentação ou painel |
| Votação | `votar.html?m=<id>` | Celulares dos participantes (navegador ou PWA), sem login |
| Apresentação | `apresentacao.html?m=<id>` | Telão/projetor |
| Painel | `admin.html` | Mesa (login com e-mail e senha do Firebase Authentication) |

> **Não é "sem infraestrutura".** Não há servidor próprio para manter, mas o sistema depende de um
> serviço externo gerenciado (Firebase, do Google), com sua conta, seus limites e sua disponibilidade.
> O NOMEIA também **não é um sistema de eleição formal** (veja [Riscos e limites](#riscos-e-limites)).

---

## Arquitetura

```
GitHub Pages (arquivos estáticos)          Firebase (serviço gerenciado)
┌───────────────────────────┐   SDK JS    ┌────────────────────────────────────┐
│ index / votar /           │ ──────────▶ │ Realtime Database                  │
│ apresentacao / admin      │  tempo real │   meetings/   cargos e candidatos  │
│ (PWA + service worker)    │ ◀────────── │   counts/     total de votos       │
└───────────────────────────┘             │   tallies/    votos por opção      │
                                          │   receipts/   recibos (1 por voto) │
                                          │   results/    resultados selados   │
                                          │   log/        registro da mesa     │
                                          │ Regras: database.rules.json        │
                                          │ Authentication (contas da mesa)    │
                                          └────────────────────────────────────┘
```

- **Fonte da verdade:** o banco do Firebase. Todas as telas escutam o banco e se atualizam sozinhas
  (candidato adicionado, votação aberta, próximo cargo, resultados publicados).
- **Segurança no servidor do Firebase, não na interface:** as regras (`database.rules.json`) decidem o que
  cada um pode gravar. O JavaScript público não tem segredo nenhum.
- **Voto público e atômico:** cada confirmação grava, numa única operação, um recibo de criação única
  (`receipts/`), +1 no contador da opção (`tallies/`) e +1 no total (`counts/`). Se qualquer parte for
  recusada pelas regras, nada é gravado.
- **Sem servidor Node:** o Node.js só é usado no computador de desenvolvimento (testes, emulador,
  pré-visualização). Nada roda em produção além do GitHub Pages e do Firebase.

### O que as regras garantem

| Quem | Pode | Não pode |
| --- | --- | --- |
| Participante (sem login) | Ler reuniões, cargos, candidatos e o total de votos; votar (+1) **somente** com a votação do cargo atual aberta, em opção existente ou abstenção | Alterar cargos, candidatos, estados ou resultados; definir/subtrair/apagar contadores; ler a apuração por candidato antes da publicação (exceto no modo "ao vivo"); ler recibos |
| Conta autenticada fora de `/admins` | O mesmo que o participante | Qualquer ação administrativa |
| Mesa (UID em `/admins`) | Criar/editar reuniões, cargos e candidatos; abrir/encerrar votação; selar e publicar resultados; encerrar reunião; importar | Alterar a apuração; regravar ou apagar resultado selado; reabrir cargo encerrado; editar candidatos com votação aberta/encerrada; apagar reuniões; alterar reunião encerrada; promover contas a admin |

Votação pública: **qualquer pessoa com o link vota, quantas vezes confirmar**. Não há bloqueio por IP,
cookie, aparelho ou armazenamento local. O recibo serve apenas para que **a mesma confirmação**
(duplo clique ou reenvio após falha de rede) não conte duas vezes.

---

## Configuração externa (passo a passo)

São necessárias **uma conta Google**, **um projeto Firebase** e o **Firebase CLI** no computador da mesa.

### 1. Criar o projeto
1. Acesse <https://console.firebase.google.com> → **Adicionar projeto** (Analytics é opcional).
2. No projeto: **Build → Realtime Database → Criar banco de dados**. Escolha a localização
   (ex.: `us-central1`) e inicie em **modo bloqueado**.
3. **Build → Authentication → Começar → Método de login → E-mail/senha → Ativar**.

### 2. Registrar o app Web e preencher `public/js/firebase-config.js`
1. **Configurações do projeto → Seus apps → Web (`</>`)** → registre o app (não precisa de Hosting).
2. Copie o objeto `firebaseConfig` exibido e substitua `export const firebaseConfig = null;` em
   `public/js/firebase-config.js`. Confira se contém `databaseURL`
   (ex.: `https://SEU-PROJETO-default-rtdb.firebaseio.com`).
3. Esses valores **não são segredos** (identificam o projeto). Mantenha `emulator = null` em produção.

### 3. Publicar as regras de segurança
```bash
npm install
npx firebase login
npx firebase use --add          # selecione o projeto criado (alias "default")
npm run deploy:rules            # publica database.rules.json
```
Alternativa sem CLI: **Realtime Database → Regras**, colar o conteúdo de `database.rules.json` → **Publicar**.
**Sem esta etapa o banco fica bloqueado (ou, pior, aberto, se alguém mudar para modo de teste).**

### 4. Criar a conta da mesa e autorizá-la
1. **Authentication → Users → Adicionar usuário** (e-mail e senha forte). Copie o **UID** do usuário.
2. **Realtime Database → Dados**: na raiz, adicione o nó `admins` e, dentro dele, a chave `<UID>` com o
   valor **booleano** `true` (não o texto "true"). Repita para cada pessoa da mesa.
3. O app nunca consegue gravar em `admins/` (regra `".write": false`): só o console do Firebase.

### 5. Autorizar o domínio do GitHub Pages
**Authentication → Settings → Authorized domains → Add domain** → `devtiagoro.github.io`.

### 6. Publicar no GitHub Pages
O repositório já publica a raiz do branch `main`: `index.html` da raiz leva a `public/index.html` e o
`.nojekyll` evita o processamento Jekyll. Depois de configurar o Firebase e testar, faça commit e push.
Endereços: `https://devtiagoro.github.io/nomeacao/` (início), `.../public/admin.html` (painel).

### 7. Recomendado
- **Firebase App Check** (reCAPTCHA Enterprise) para dificultar scripts automatizados enviando votos.
- **Alertas de cobrança** no Google Cloud. O plano gratuito (Spark) permite 100 conexões simultâneas no
  Realtime Database; acima disso, use o plano Blaze (pago por uso).
- **Backups:** exporte o JSON de cada reunião ao final (painel → Exportação). Backups automáticos diários
  do Realtime Database existem apenas no plano Blaze.

---

## Desenvolvimento local

Requisitos: Node.js 20.10+ (para ferramentas) e **Java 11+** (para o emulador do Firebase).

```bash
npm install
npm test              # testes de domínio, PWA e navegação no GitHub Pages (sem Java)
npm run test:rules    # testes das regras de segurança no emulador oficial (requer Java)
npm run emulators     # banco + Authentication locais (127.0.0.1:9000 e :9099)
npm start             # pré-visualização estática em http://localhost:8080/
```

Para usar o app com o emulador, configure temporariamente `public/js/firebase-config.js` com um projeto
`demo-nomeia` (`databaseURL: 'https://demo-nomeia-default-rtdb.firebaseio.com'`) e
`emulator = { host: '127.0.0.1', databasePort: 9000, authPort: 9099 }`. Crie a conta e o nó `admins/<UID>`
no emulador. **Não publique** com o emulador habilitado.

No VS Code há configurações de execução em `.vscode/launch.json` (pré-visualização e testes).

### Estrutura

```
index.html                 entrada do GitHub Pages → public/index.html
database.rules.json        regras de segurança do Realtime Database (a autoridade)
firebase.json, .firebaserc emulador e publicação das regras
public/
  index.html votar.html apresentacao.html admin.html offline.html
  js/firebase-config.js    configuração pública do projeto Firebase
  js/db.js                 acesso ao Firebase (tempo real, voto atômico, ações da mesa)
  js/domain.js             apuração, selo SHA-256, CSV, exportação/importação
  js/common.js             interface (ícones, resultados, diálogos, avisos)
  js/index.js votar.js apresentacao.js admin.js offline.js
  css/  icons/  manifest.webmanifest  sw.js
test/                      testes (node --test) + test/rules (emulador)
scripts/serve.js           pré-visualização local; scripts/gen-icons.js
```

## Uso na reunião

1. Mesa entra no **Painel**, cria a reunião (nome e **pessoas presentes**) e o primeiro cargo.
2. Abre a **Apresentação** no telão; os participantes leem o QR Code (ou acessam a página inicial).
3. Mesa adiciona os nomes — aparecem ao vivo no telão e nos celulares; o voto fica bloqueado.
4. **Abrir votação** → os celulares liberam a escolha. Cada **Confirmar meu voto** registra um voto;
   "Votar novamente" permite novos votos intencionais.
5. **Encerrar votação** → as regras passam a recusar votos; o painel lê a contagem final e grava o
   resultado com selo SHA-256 (gravação única). **Publicar** libera o resultado para todos.
6. **Próximo cargo** → telas mudam sozinhas, sem novo QR Code. O anterior fica no **Histórico**.
7. Ao final: **Exportar JSON** (cópia de segurança, reimportável) e **CSV** (planilha).

"Pessoas presentes" é informado pela mesa; "votos recebidos" é contado. São números independentes.

### Importação
O painel importa exportações JSON desta versão e também **backups da versão anterior** (servidor Node,
arquivos `data/backups/*.json` ou exportações), verificando o selo de cada resultado. Os contadores
parciais de votações que estavam abertas no momento da exportação não podem ser restaurados (as regras
só aceitam votos reais, +1 por vez). Reuniões existentes nunca são sobrescritas.

## PWA
Instalável (manifest, ícones, service worker). O service worker guarda apenas a casca do app; dados do
Firebase e votos nunca são armazenados nem enfileirados — sem conexão, o voto é recusado na hora.
Não há notificações push nem atualização com o app totalmente fechado; ao reabrir, o estado atual é buscado.

## Testes

- `npm test` — 20 testes: apuração, percentuais, empate, zero votos, abstenções × válidos × presentes,
  selo SHA-256, CSV (inclusive injeção de fórmulas), exportar/importar (v3 e v2), adulteração recusada,
  PWA, página inicial, ausência de segredos e de bloqueios por aparelho, navegação sob `/nomeacao/`.
- `npm run test:rules` — 12 testes contra o **emulador oficial**: participante não altera nada; só UIDs em
  `/admins` gravam; candidatos travados com votação aberta/encerrada; estados só avançam; voto aceito só
  com votação aberta; votos repetidos aceitos; 40 votos simultâneos contados corretamente; retransmissão
  recusada por inteiro; contadores só aceitam +1; apuração oculta até publicar; resultado imutável;
  reunião encerrada somente leitura; registro só de inclusão.

## Riscos e limites

- **Votação aberta a qualquer pessoa com o link**, inclusive votos repetidos (requisito). Não há garantia
  de uma pessoa por voto; o total de votos pode superar o de presentes. Use apenas onde isso é aceitável.
- **Abuso automatizado:** um script pode enviar muitos votos enquanto a votação estiver aberta (as regras
  só garantem +1 por operação). App Check reduz esse risco; não o elimina.
- **Coerência dos contadores:** `counts/` (total público) e `tallies/` (por opção) são gravados juntos pelo
  app, mas as regras não conseguem provar que andam sempre juntos. O resultado oficial é calculado de
  `tallies/` no encerramento e selado.
- **Mesa é confiável:** contas em `/admins` controlam cargos e o encerramento. As regras impedem alterar
  apuração e resultados selados, mas a mesa ainda pode, por exemplo, remover um candidato de um cargo já
  encerrado da lista exibida (o resultado selado, que contém todos os candidatos, não muda).
- **Dependência externa:** indisponibilidade do Firebase, do CDN do Google (SDK) ou do jsDelivr (QR Code)
  afeta o sistema. Limites do plano gratuito (100 conexões simultâneas) podem exigir o plano Blaze.
- **Encerramento em duas etapas:** se a conexão da mesa cair entre "encerrar" e "selar", o painel mostra
  **Concluir apuração** para terminar (nenhum voto entra nesse intervalo: o cargo já está encerrado).
- **Sigilo:** não há identificação de quem votou. A mesa vê a apuração parcial em tempo real.
