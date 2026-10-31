import { api, $, storage, isMeetingId, registerServiceWorker, setupOfflineBar } from './common.js';

registerServiceWorker();
setupOfflineBar();

const params = new URLSearchParams(location.search);
const m = params.get('m');
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

if (isMeetingId(m) || location.hash.includes('t=')) {
  // Links de reunião/credencial seguem direto para a votação (o fragmento é preservado).
  location.replace(`/votar.html${isMeetingId(m) ? `?m=${encodeURIComponent(m)}` : ''}${location.hash}`);
} else {
  const last = storage.lastMeeting();
  if (isMeetingId(last)) {
    // App instalado: abre direto na reunião vinculada e busca o estado atual.
    if (standalone) location.replace(`/votar.html?m=${encodeURIComponent(last)}`);
    $('#continue').hidden = false;
    $('#continue-link').href = `/votar.html?m=${encodeURIComponent(last)}`;
  }
}

$('#code-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = $('#code-error');
  err.hidden = true;
  const code = $('#code').value.trim();
  if (!code) return;
  const btn = ev.submitter;
  btn.disabled = true;
  try {
    const info = await api('/api/credentials/check', { method: 'POST', credential: code });
    // A tela de votação pede o consentimento para guardar a credencial.
    location.href = `/votar.html?m=${encodeURIComponent(info.meetingId)}#t=${encodeURIComponent(code)}`;
  } catch (e) {
    err.textContent = e.code === 'invalid_credential' ? 'Código não reconhecido. Confira e tente novamente.' : e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});
