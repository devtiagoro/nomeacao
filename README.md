# NOMEIA

Nomeações e votações em **reuniões presenciais**. Site estático (HTML, CSS e JavaScript puro) no
**GitHub Pages**, com sincronização em tempo real entre aparelhos pelo **Firebase Realtime Database**.

Não é um sistema eleitoral formal: não há cadastro de participantes, credenciais ou controle de
um voto por pessoa.

| Tela | Endereço | Quem usa |
| --- | --- | --- |
| Início | `https://devtiagoro.github.io/nomeacao/` | Todos |
| Votação pública | `.../public/votar.html` | Celulares, sem login |
| Apresentação | `.../public/apresentacao.html` | Telão/projetor |
| Administração | `.../public/admin.html` | Quem conduz a reunião (e-mail e senha) |

## Como funciona

- Um site estático **não sincroniza aparelhos sozinho**. O Firebase (serviço gerenciado do Google)
  guarda os dados e avisa todas as telas a cada mudança. Não há servidor próprio.
- O banco aponta qual é a **reunião em andamento**; votação e apresentação seguem esse ponteiro.
  Próximo cargo e nova reunião aparecem sozinhos, sem ler o QR Code de novo.
- **Quem pode o quê** é decidido pelas regras do banco (`database.rules.json`), não pela interface:
  - participantes leem a reunião e registram votos apenas enquanto a votação do cargo atual está aberta;
  - só contas cadastradas em `admins/` criam reuniões e cargos, alteram nomes, abrem e encerram votações;
  - contadores só aceitam +1; um cargo encerrado não pode mais ser alterado nem apagado, nem pelo administrador.
- Cada **Confirmar voto** grava, numa operação atômica, uma cédula: +1 para cada nome marcado (ou +1
  abstenção) e +1 no total de cédulas. Uma marca única por confirmação impede que um reenvio por falha
  de rede conte duas vezes. Votar de novo de propósito é permitido.

### Fluxo da reunião

1. **Administração** → *Nova reunião* (nome e pessoas presentes).
2. *Novo cargo*: nome, **escolha única** ou **múltipla escolha** (com máximo de nomes por cédula).
3. Adicionar, editar ou remover nomes → **Apresentar** (aparece no telão e nos celulares).
4. **Abrir votação** → a lista fica bloqueada; o painel mostra votos registrados e a parcial.
   Opcional: *mostrar resultado parcial ao vivo* para todos.
5. **Encerrar votação** → resultado final aparece no telão e nos celulares.
6. **Próximo cargo**. O histórico fica no painel; **Exportar JSON/CSV** a qualquer momento.

## Configuração inicial (uma vez)

Requer uma conta Google. Tudo pelo console do Firebase, sem custo no plano gratuito (Spark).

1. <https://console.firebase.google.com> → **Adicionar projeto**.
2. **Realtime Database → Criar banco de dados** (modo bloqueado).
3. **Authentication → Método de login → E-mail/senha → Ativar.**
4. **Configurações do projeto → Seus apps → Web (`</>`)** → copie o objeto `firebaseConfig` para
   `public/js/firebase-config.js` (substituindo `null`). Confira se contém `databaseURL`.
   Esses valores não são segredos.
5. **Realtime Database → Regras** → cole o conteúdo de `database.rules.json` → **Publicar**.
   (Ou: `npx firebase login`, `npx firebase use --add`, `npm run deploy:rules`.)
6. **Authentication → Users → Adicionar usuário** (e-mail e senha do administrador) e copie o **UID**.
7. **Realtime Database → Dados** → crie `admins` → `<UID>` com valor booleano `true`.
8. **Authentication → Settings → Authorized domains** → adicione `devtiagoro.github.io`.
9. Faça commit e push. O GitHub Pages publica a raiz do branch `main`.

Sem os passos 4 e 5 a votação mostra "indisponível no momento" (nada é simulado).

## Dados

```
current                         id da reunião em andamento
meetings/{m}                    nome, pessoas presentes, criação, cargo atual
meetings/{m}/offices/{o}        nome do cargo, tipo (single|multiple), máximo de escolhas,
                                estado (draft|discussing|voting_open|closed), parcial ao vivo,
                                criado/apresentado/aberto/encerrado em, candidatos
counts/{m}/{o}                  cédulas registradas
tallies/{m}/{o}/{c|abstain}     votos por candidato e abstenções
receipts/{m}/{o}/{id}           marca de cada confirmação (não legível)
```

O resultado é calculado desses contadores (que ficam definitivos ao encerrar). Percentual de cada nome
= votos ÷ cédulas válidas; na múltipla escolha a soma pode passar de 100%. Reuniões e cargos encerrados
ficam no banco: o histórico sobrevive ao fechamento do navegador e ao fim da reunião.

## Desenvolvimento

```bash
npm install
npm test              # domínio, sincronização entre telas (banco em memória) e publicação em /nomeacao/
npm run test:rules    # regras de segurança no emulador oficial do Firebase (requer Java 11+)
npm start             # pré-visualização em http://localhost:8080/
```

Para usar o app contra o emulador (`npm run emulators`), configure temporariamente
`public/js/firebase-config.js` com `databaseURL: 'https://demo-nomeia-default-rtdb.firebaseio.com'` e
`emulator = { host: '127.0.0.1', databasePort: 9000, authPort: 9099 }`. Não publique assim.

```
index.html                 entrada do GitHub Pages → public/index.html
database.rules.json        regras de segurança (a autoridade)
public/js/db.js            Firebase: tempo real, voto, ações do administrador
public/js/domain.js        cédula, apuração, CSV, exportação
public/js/common.js        interface compartilhada (elementos, ícones, resultados, diálogos)
public/js/admin.js votar.js apresentacao.js
```

## Limites conhecidos

- Qualquer pessoa com o link vota, quantas vezes confirmar; o total pode superar o de presentes.
- O limite de nomes por cédula e a regra de escolha única são verificados no aparelho; um script
  malicioso poderia burlá-los (assim como pode votar várias vezes).
- O administrador é confiável: as regras não impedem que ele remova um nome durante a votação aberta
  (a interface impede). Depois de encerrado, o cargo fica imutável.
- Depende da disponibilidade do Firebase e dos CDNs (SDK do Google, QR Code no jsDelivr). O plano gratuito
  admite 100 conexões simultâneas.
- `public/sw.js` só remove o service worker de versões anteriores; pode ser apagado depois.
