import {PROFILE} from './profile.js';
const state = document.querySelector('#state');
const title = document.querySelector('#document');
const error = document.querySelector('#error');
const attach = document.querySelector('#attach');
const disconnect = document.querySelector('#disconnect');
const languageButton = document.querySelector('#language');
const messages = {
  en: {checking:'Checking connection…', connected:'Tab control is enabled', disconnected:'No tab connected', attach:'Connect this tab', switchTab:'Connect the current tab', disconnect:'Disconnect', subtitle:'Google Vids · local bridge', hint:`Connect an open video. ${PROFILE.clientName} can read the editor, enter text and control this tab.`, footer:'One document per connection. Navigating to another document disconnects control.', noResponse:'The extension did not respond.', language:'Переключить на русский', wrongPage:'Open a Google Vids document: docs.google.com/videos/d/…'},
  ru: {checking:'Проверяем подключение…', connected:'Управление вкладкой включено', disconnected:'Вкладка не подключена', attach:'Подключить эту вкладку', switchTab:'Подключить текущую вкладку', disconnect:'Отключить', subtitle:'Google Vids · локальный мост', hint:`Подключите открытое видео. ${PROFILE.clientName} сможет читать интерфейс, вводить текст и управлять этой вкладкой.`, footer:'Подключение действует для одного документа. Смена документа отключает управление.', noResponse:'Расширение не ответило.', language:'Switch to English', wrongPage:'Откройте документ Google Vids: docs.google.com/videos/d/…'},
};
const savedLanguage = localStorage.getItem('popupLanguage');
let language = ['en','ru'].includes(savedLanguage) ? savedLanguage : navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
let pending = false;
let latestStatus = null;
let failure = null;
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
  state.textContent = latestStatus ? latestStatus.attached ? text.connected : text.disconnected : text.checking;
  title.textContent = latestStatus?.title || '';
  disconnect.hidden = !latestStatus?.attached;
  disconnect.textContent = text.disconnect;
  attach.textContent = latestStatus?.attached ? text.switchTab : text.attach;
  const problem = failure || latestStatus?.lastError;
  error.hidden = !problem;
  error.textContent = problem?.code === 'WRONG_PAGE' ? text.wrongPage : typeof problem === 'string' ? problem : problem?.message || '';
}
async function request(type) {
  if (pending) return;
  pending = true;
  attach.disabled = disconnect.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({type});
    if (!response?.ok) throw Object.assign(new Error(response?.error?.message || messages[language].noResponse), {code:response?.error?.code});
    const bindingChanged = latestStatus && (Boolean(latestStatus.attached) !== Boolean(response.result?.attached)
      || latestStatus.sessionId !== response.result?.sessionId);
    latestStatus = response.result;
    // Retain an explicit action error across read-only refreshes; clear it only
    // after a successful user action or an actual attached-state transition.
    if (type !== 'status' || failure?.source === 'status' || bindingChanged) failure = null;
  } catch (problem) { failure = {source:type, code:problem.code, message:problem.message}; }
  finally { pending = false; attach.disabled = disconnect.disabled = false; render(); }
}
languageButton.addEventListener('click', () => {
  language = language === 'en' ? 'ru' : 'en';
  localStorage.setItem('popupLanguage', language);
  render();
});
attach.addEventListener('click', () => void request('attach'));
disconnect.addEventListener('click', () => void request('disconnect'));
render();
void request('status');
// The popup exists only while visible; this catches native-host startup errors.
setInterval(() => void request('status'), 1500);
