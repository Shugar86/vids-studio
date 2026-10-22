import {PROFILE} from './profile.js';
const state = document.querySelector('#state');
const error = document.querySelector('#error');
const attach = document.querySelector('#attach');
const list = document.querySelector('#connections');
const pairingBox = document.querySelector('#pairing');
const languageButton = document.querySelector('#language');
const messages = {
  en: {checking:'Checking connections…', connected:n=>`${n} connected ${n===1?'video':'videos'}`, disconnected:'No tab connected', attach:'Connect this tab', disconnect:'Disconnect', pair:'Show pairing code', claimed:'Paired with a chat', available:'Ready to pair', subtitle:'Google Vids · parallel workspace', hint:`Connect this video, then give its one-use code to the ${PROFILE.clientName} chat that will edit it. Other connected videos keep working.`, footer:'Each chat controls its paired document. Switching tabs does not switch its connection.', noResponse:'The extension did not respond.', language:'Переключить на русский', wrongPage:'Open a Google Vids document: docs.google.com/videos/d/…', pairHint:'Send this one-use code only to the chat that should control this video:', paired:'This connection is already paired. Disconnect and reconnect it to assign a different chat.', current:'Current tab', recovery:'Needs attention'},
  ru: {checking:'Проверяем подключения…', connected:n=>`Подключено видео: ${n}`, disconnected:'Вкладка не подключена', attach:'Подключить эту вкладку', disconnect:'Отключить', pair:'Код подключения', claimed:'Связано с чатом', available:'Можно связать с чатом', subtitle:'Google Vids · параллельная работа', hint:`Подключите это видео и передайте одноразовый код тому чату ${PROFILE.clientName}, который будет его редактировать. Остальные подключения продолжат работать.`, footer:'Каждый чат управляет своим документом. Переключение вкладок не меняет его подключение.', noResponse:'Расширение не ответило.', language:'Switch to English', wrongPage:'Откройте документ Google Vids: docs.google.com/videos/d/…', pairHint:'Передайте этот одноразовый код только чату, которому поручаете это видео:', paired:'Подключение уже связано с чатом. Для другого чата отключите и заново подключите это видео.', current:'Текущая вкладка', recovery:'Требует внимания'},
};
const savedLanguage = localStorage.getItem('popupLanguage');
let language = ['en','ru'].includes(savedLanguage) ? savedLanguage : navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
let pending = false, latestStatus = null, failure = null, latestPairing = null;
function render() {
  const text = messages[language];
  document.documentElement.lang = language;
  document.title = PROFILE.displayName;
  document.querySelector('#name').textContent = PROFILE.displayName;
  document.querySelector('#subtitle').textContent = text.subtitle;
  document.querySelector('#hint').textContent = text.hint;
  document.querySelector('#footer').textContent = text.footer;
  languageButton.textContent = language === 'en' ? 'RU' : 'EN';
  languageButton.setAttribute('aria-label', text.language);
  const sessions = latestStatus?.sessions || [];
  state.textContent = latestStatus ? sessions.length ? text.connected(sessions.length) : text.disconnected : text.checking;
  attach.textContent = text.attach;
  list.replaceChildren();
  for (const session of sessions) {
    const row = document.createElement('li');
    row.className = 'connection';
    const name = document.createElement('strong');
    name.textContent = session.title || session.documentId;
    const detail = document.createElement('p');
    detail.textContent = [session.sessionId === latestStatus.currentSessionId ? text.current : null,
      session.recovery ? text.recovery : session.pairingState === 'claimed' ? text.claimed : text.available].filter(Boolean).join(' · ');
    const actions = document.createElement('div'); actions.className = 'row-actions';
    for (const [kind, label] of [['pairing', text.pair], ['disconnect', text.disconnect]]) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'secondary'; button.textContent = label; button.disabled = pending;
      button.addEventListener('click', () => void request(kind, session.sessionId));
      actions.append(button);
    }
    row.append(name, detail, actions); list.append(row);
  }
  const session = sessions.find(item => item.sessionId === latestPairing?.sessionId);
  if (!session || session.pairingState === 'claimed') latestPairing = null;
  pairingBox.hidden = !latestPairing;
  document.querySelector('#pairing-hint').textContent = text.pairHint;
  const code = document.querySelector('#pairing-code');
  code.value = latestPairing?.ticket || '';
  const problem = failure;
  error.hidden = !problem;
  error.textContent = problem?.code === 'WRONG_PAGE' ? text.wrongPage : problem?.message || '';
}
async function request(type, sessionId) {
  if (pending) return;
  pending = true; attach.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({type, ...(sessionId ? {sessionId} : {})});
    if (!response?.ok) throw Object.assign(new Error(response?.error?.message || messages[language].noResponse), {code:response?.error?.code});
    if (type === 'attach') {
      latestStatus = response.result.status;
      latestPairing = response.result.pairing?.ticket ? response.result.pairing : null;
    } else if (type === 'pairing') {
      latestPairing = response.result.ticket ? response.result : null;
      if (!latestPairing) throw new Error(messages[language].paired);
    } else latestStatus = response.result;
    const failedTargetDetached = failure?.sessionId && !latestStatus?.sessions?.some(item => item.sessionId === failure.sessionId);
    const failedCurrentChanged = failure && !failure.sessionId && failure.currentSessionId !== (latestStatus?.currentSessionId ?? null);
    if (type !== 'status' || failure?.source === 'status' || failedTargetDetached || failedCurrentChanged) failure = null;
  } catch (problem) { failure = {source:type, sessionId, currentSessionId:latestStatus?.currentSessionId ?? null, code:problem.code, message:problem.message}; }
  finally { pending = false; attach.disabled = false; render(); }
}
languageButton.addEventListener('click', () => {
  language = language === 'en' ? 'ru' : 'en';
  localStorage.setItem('popupLanguage', language); render();
});
attach.addEventListener('click', () => void request('attach'));
render(); void request('status');
setInterval(() => void request('status'), 1500);
