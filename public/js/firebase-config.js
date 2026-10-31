// NOMEIA — configuração do Firebase (serviço gerenciado de sincronização em tempo real).
//
// Preencha com o objeto de configuração do app Web do SEU projeto:
//   Console do Firebase → Configurações do projeto → Seus apps → app Web → "SDK setup and configuration".
//
// Estes valores NÃO são segredos: apenas identificam o projeto e ficam públicos em qualquer app Web.
// Quem protege os dados são as regras do banco (database.rules.json, publicadas no Firebase)
// e o Firebase Authentication (contas da mesa cadastradas em /admins).
// Nunca coloque aqui senhas, tokens de serviço ou chaves de conta de serviço.
//
// Enquanto ficar null, as páginas mostram "Firebase não configurado" (nada é simulado).

export const firebaseConfig = null;

/* Exemplo (substitua pelos valores do seu projeto):
export const firebaseConfig = {
  apiKey: 'AIza...',
  authDomain: 'seu-projeto.firebaseapp.com',
  databaseURL: 'https://console.firebase.google.com/u/0/project/nomeacao-905ed/database/nomeacao-905ed-default-rtdb/data/~2F?hl=pt-br',
  projectId: 'seu-projeto',
  appId: '1:000000000000:web:0000000000000000',
};
*/

// Somente para desenvolvimento local com o Firebase Emulator Suite. Deixe null em produção.
// Ex.: { host: '127.0.0.1', databasePort: 9000, authPort: 9099 }
export const emulator = null;
