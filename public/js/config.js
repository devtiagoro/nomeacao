// NOMEIA — configuração do front-end.
//
// API_BASE: endereço do servidor Node.js do NOMEIA (API HTTP + WebSocket), SEM barra no final.
//
// • Vazio ('')  → usa o mesmo endereço desta página. É o caso quando o próprio servidor Node
//                 entrega os arquivos (npm start, rede local, servidor em produção).
// • Preenchido  → necessário quando o front-end está em hospedagem estática, como o GitHub Pages,
//                 que NÃO executa Node.js. Ex.: 'https://nomeia-api.suaorg.org.br'
//                 No servidor, defina PUBLIC_APP_URL com o endereço desta página publicada
//                 (ex.: https://devtiagoro.github.io/nomeacao/) para liberar o CORS e gerar os QR Codes.
//
// Nunca coloque segredos aqui: este arquivo é público.
export const API_BASE = '';
