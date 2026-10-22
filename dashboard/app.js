/* The fragment is removed immediately and is never sent in a URL or persisted. */
const capability = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const $ = id => document.getElementById(id);
let language = localStorage.getItem('vids-monitor-language') === 'en' ? 'en' : 'ru';
let latest = null, healthy = false, attempted = false, busy = false, filter = 'all', timer;
const copy = {
  ru: {skip:'К роликам',monitor:'Монитор',local:'На этом компьютере',title:'Каждый ролик — на своём месте.',subtitle:'Общий обзор работы Codex и Claude. Без переключения ваших вкладок.',admission:'Новые команды',admissionHelp:'Пауза не отменяет уже отправленные действия.',parallelLimit:'Предел одновременных команд',apply:'Применить',pauseAll:'Приостановить новые команды',resumeAll:'Продолжить новые команды',resourceNote:'Снимки и содержимое видео здесь не запрашиваются.',videos:'Ролики',all:'Все',attention:'Требуют внимания',working:'В работе',video:'Документ',state:'Состояние',owner:'Кто работает',pending:'Незавершённые',updated:'Обновлено',actions:'Действия',footer:'Состояния приходят от локальных подключений. Отсутствие свежих сведений не означает, что операция остановилась.',noProgress:'Без выдуманных процентов готовности',connecting:'Подключение…',live:'Сведения поступают',unavailable:'Нет связи с реестром',auth:'Откройте приватную ссылку, которую напечатала команда npm run monitor. После перезагрузки страницы ключ из ссылки нужно открыть заново.',failed:'Не удалось прочитать локальный реестр. Последние сведения могут быть устаревшими; браузерные действия не повторяются.',controlFailed:'Изменение режима не подтверждено. Проверьте обновлённое состояние перед следующей попыткой.',emptyTitle:'Подключённые ролики появятся здесь',emptyDescription:'Откройте нужный Google Vids и подключите его через расширение Vids Studio. Затем закрепите ролик за своим чатом. Старая загруженная версия расширения может ещё не передавать сведения в этот монитор.',filteredTitle:'В этой группе пока нет роликов',filteredDescription:'Остальные подключения доступны в разделе «Все».',pausedTitle:'Новые команды приостановлены',runningTitle:'Новые команды разрешены',effective:'Сейчас допускается',commands:'команд',memory:'Свободная память',cpu:'CPU',pressure:'Нагрузка',unknown:'нет сведений',now:'только что',ago:'назад',seconds:'с',minutes:'мин',hours:'ч',stale:'Сведения устарели',unassigned:'Чат не закреплён',document:'Документ Vids',browser:'Браузер',session:'Сессия',pause:'Пауза',resume:'Продолжить',activeCount:'работают',remoteCount:'ждут Google',throttledCount:'ограничены',attentionCount:'требуют внимания',idleCount:'ожидают команд',pendingCount:'операций без окончательного ответа',privacy:'Ключ подключения отсутствует',fresh:'Обновлено',runtime:'Runtime',exports:'Экспорты MP4',exportsHelp:'Сохранённые этапы экспорта остаются здесь после закрытия чата. Проверка файла не заменяет просмотр ролика.',exportStage:'Этап экспорта',exportsUnavailable:'Часть локальных записей экспорта недоступна. Состояния этих заданий не установлены.',localVerifiers:'Слоты проверки MP4',verifiedFile:'Файл технически проверен',cancelPending:'Запрошена остановка следующих шагов'},
  en: {skip:'Skip to videos',monitor:'Monitor',local:'On this computer',title:'Every video has its own place.',subtitle:'One view of Codex and Claude work, without switching your tabs.',admission:'New commands',admissionHelp:'Pausing does not cancel actions already dispatched.',parallelLimit:'Concurrent command limit',apply:'Apply',pauseAll:'Pause new commands',resumeAll:'Resume new commands',resourceNote:'This panel does not request screenshots or video content.',videos:'Videos',all:'All',attention:'Needs attention',working:'Working',video:'Document',state:'State',owner:'Working on it',pending:'Unsettled',updated:'Updated',actions:'Actions',footer:'States are reported by local connections. Missing fresh information does not mean an operation has stopped.',noProgress:'No invented completion percentages',connecting:'Connecting…',live:'Receiving updates',unavailable:'Registry unavailable',auth:'Open the private link printed by npm run monitor. After reloading this page, reopen the original link with its access key.',failed:'The local registry could not be read. Last-known information may be stale; browser actions are not replayed.',controlFailed:'The policy change was not confirmed. Check the refreshed state before trying again.',emptyTitle:'Connected videos will appear here',emptyDescription:'Open the intended Google Vids document and attach it using the Vids Studio extension. Then reserve it from its chat. An older loaded extension may not report to this monitor yet.',filteredTitle:'No videos in this group',filteredDescription:'Other connections are available under All.',pausedTitle:'New commands are paused',runningTitle:'New commands are allowed',effective:'Currently admitted',commands:'commands',memory:'Available memory',cpu:'CPU',pressure:'Pressure',unknown:'not reported',now:'just now',ago:'ago',seconds:'s',minutes:'min',hours:'h',stale:'Information is stale',unassigned:'No chat reserved',document:'Vids document',browser:'Browser',session:'Session',pause:'Pause',resume:'Resume',activeCount:'working',remoteCount:'waiting for Google',throttledCount:'throttled',attentionCount:'need attention',idleCount:'awaiting commands',pendingCount:'operations without a final receipt',privacy:'Access key missing',fresh:'Updated',runtime:'Runtime',exports:'MP4 exports',exportsHelp:'Saved export stages remain available after the chat closes. File validation does not replace watching the video.',exportStage:'Export stage',exportsUnavailable:'Some local export records are unavailable. Their outcomes are not established.',localVerifiers:'MP4 verification slots',verifiedFile:'File technically verified',cancelPending:'Stopping further steps requested'},
};
const states = {
  active:['Работает локально','Working locally','active'], active_local:['Работает локально','Working locally','active'], running:['Выполняет команду','Executing command','active'],
  attached:['Ожидает команд','Awaiting commands',''], idle:['Ожидает команд','Awaiting commands',''], ready:['Ожидает команд','Awaiting commands',''],
  remote_wait:['Ждёт Google','Waiting for Google','waiting'], waiting_google:['Ждёт Google','Waiting for Google','waiting'], waiting_download:['Скачивает','Downloading','waiting'], verifying:['Проверяет файл','Verifying file','active'],
  throttled:['Ограничен ресурсами','Resource throttled','paused'], throttled_resource:['Ограничен ресурсами','Resource throttled','paused'], paused:['Новые команды на паузе','New commands paused','paused'],
  stale:['Нет свежих сведений','No fresh information','attention'], disconnected:['Отключён','Disconnected','attention'], needs_reconciliation:['Нужна сверка','Reconciliation needed','attention'], needs_attention:['Требует внимания','Needs attention','attention'], error:['Ошибка','Error','attention'],
};
const exportStages = {queued:['В очереди экспорта','Export queued'],opening_file_menu:['Открывает меню экспорта','Opening export menu'],menu_intent_saved:['Отправляет команду меню','Dispatching menu command'],trigger_intent_saved:['Запускает выгрузку','Triggering export'],waiting_for_correlated_download:['Ждёт подтверждённую выгрузку','Waiting for correlated download'],download_observed_complete:['Выгрузка подтверждена','Download confirmed'],waiting_for_local_capacity:['Ждёт свободный слот проверки','Waiting for verification capacity'],verifying_local_file:['Проверяет локальный MP4','Verifying local MP4'],verified_file:['MP4 проверен','MP4 verified'],runner_unconfirmed:['Нет свежего подтверждения исполнителя','Runner has no fresh heartbeat'],stopped:['Работа остановлена','Work stopped'],download_completed_after_cancel:['Выгрузка завершилась после отмены','Download finished after cancellation'],verification_finished_after_cancel:['Проверка завершилась после отмены','Verification finished after cancellation'],local_verification_stopped:['Локальная проверка остановлена','Local verification stopped']};
const t = key => copy[language][key] || key;
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function epoch(value) { if (typeof value === 'number') return value > 1e12 ? value : value * 1000; const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
function age(value) { const date = epoch(value); if (date === null) return t('unknown'); const elapsed = Math.max(0, (Date.now() - date) / 1000); if (elapsed < 5) return t('now'); const [n, unit] = elapsed < 60 ? [Math.floor(elapsed),'seconds'] : elapsed < 3600 ? [Math.floor(elapsed / 60),'minutes'] : [Math.floor(elapsed / 3600),'hours']; return `${n} ${t(unit)} ${t('ago')}`; }
function size(value) { return Number.isFinite(value) ? `${(value / 1024 ** 3).toFixed(1)} GB` : t('unknown'); }
function stateOf(session) { const stale = session.stale || (epoch(session.updatedAt) !== null && Date.now() - epoch(session.updatedAt) > 45000); return stale ? 'stale' : session.recovery?.phase ? 'needs_attention' : session.paused ? 'paused' : session.pending > 0 ? 'running' : session.state || 'unknown'; }
function stateLabel(state) { return states[state]?.[language === 'ru' ? 0 : 1] || `${t('unknown')} (${state})`; }
function category(session) { const state = stateOf(session); return states[state]?.[2] || ''; }
function showNotice(message) { $('notice').hidden = !message; $('notice').textContent = message || ''; }
function updateLanguage() {
  document.documentElement.lang = language; document.title = `Vids Studio — ${t('monitor')}`;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  $('language').textContent = language === 'ru' ? 'EN' : 'RU';
  $('controls').ariaLabel = language === 'ru' ? 'Управление нагрузкой' : 'Workload controls';
  document.querySelector('.resource-strip').ariaLabel = language === 'ru' ? 'Ресурсы компьютера' : 'Computer resources';
  document.querySelector('.filters').ariaLabel = language === 'ru' ? 'Фильтр роликов' : 'Filter videos';
  render();
}
function render() {
  $('connection').textContent = !capability ? t('privacy') : healthy ? t('live') : attempted ? t('unavailable') : t('connecting');
  $('connection-dot').className = `dot ${healthy ? 'live' : attempted ? 'error' : ''}`;
  $('last-update').textContent = latest ? age(latest.generatedAt) : '';
  const sessions = latest?.sessions || [], policy = latest?.policy || {};
  const enabled = healthy && !busy;
  $('pause-all').disabled = !enabled; $('apply-limit').disabled = !enabled; $('max-concurrency').disabled = !enabled;
  $('pause-all').textContent = t(policy.paused ? 'resumeAll' : 'pauseAll');
  $('admission-state').textContent = t(policy.paused ? 'pausedTitle' : 'runningTitle');
  if (document.activeElement !== $('max-concurrency') && policy.maxConcurrency !== undefined) $('max-concurrency').value = policy.maxConcurrency;
  $('effective-limit').textContent = policy.effectiveConcurrency !== undefined ? `${t('effective')}: ${policy.effectiveConcurrency}` : '';
  const adaptation = {telemetry_unavailable:['Нет полных измерений: осторожный предел','Incomplete measurements: conservative limit'],telemetry_stale:['Измерения устарели: осторожный предел','Measurements are stale: conservative limit'],memory_pressure:['Недостаточно свободной памяти','Low available memory'],resource_pressure:['Нагрузка выросла: предел снижен','Resource pressure: limit reduced'],healthy_ramp:['Предел постепенно растёт при запасе ресурсов','Ramping up while resources allow'],configured_limit:['Достигнут заданный предел','Configured limit reached'],headroom_hold:['Предел удерживается ради запаса ресурсов','Holding capacity to preserve headroom'],paused:['Новые команды приостановлены','New commands paused']};
  const why = adaptation[policy.adaptationReason]?.[language === 'ru' ? 0 : 1];
  if (why) $('effective-limit').textContent += ` · ${why}`;
  const resources = latest?.resources || {};
  const resourceAge = epoch(resources.measuredAt);
  document.querySelector('.resource-strip').title = resourceAge === null ? t('unknown') : `${t('fresh')}: ${age(resources.measuredAt)}`;
  const resourcesStale = resourceAge !== null && Date.now() - resourceAge > 15000;
  $('resource-age').textContent = resourcesStale ? `${t('stale')}: ${age(resources.measuredAt)}` : '';
  $('resource-age').className = resourcesStale ? 'stale-time' : '';
  $('memory').textContent = `${t('memory')}: ${size(resources.memoryAvailableBytes)}`;
  $('cpu').textContent = `${t('cpu')}: ${Number.isFinite(resources.cpuPercent) ? `${Math.round(resources.cpuPercent)}%` : t('unknown')}`;
  $('pressure').textContent = `${t('pressure')}: ${Number.isFinite(resources.pressure?.memory?.avg10) ? `${resources.pressure.memory.avg10.toFixed(1)}% (${language === 'ru' ? 'ожидание памяти' : 'memory stalls'})` : t('unknown')}`;
  $('media-budget').textContent = latest?.localMedia?.status === 'available' ? `${t('localVerifiers')}: ${latest.localMedia.reservedSlots} / ${latest.localMedia.maxSlots}` : '';
  $('total-count').textContent = String(sessions.length);
  const counts = {activeCount:0,throttledCount:0,attentionCount:0,idleCount:0}; if (sessions.some(session=>['remote_wait','waiting_google'].includes(session.state))) counts.remoteCount = 0;
  for (const session of sessions) { const state = stateOf(session), group = category(session); if (['remote_wait','waiting_google'].includes(state)) counts.remoteCount++; else if (group === 'active') counts.activeCount++; else if (group === 'attention') counts.attentionCount++; else if (group === 'paused') counts.throttledCount++; else counts.idleCount++; }
  $('totals').replaceChildren(...Object.entries(counts).map(([key,value]) => { const node = element('span'); node.append(element('strong','',value), document.createTextNode(t(key))); return node; }));
  const shown = sessions.filter(session => filter === 'all' || (filter === 'attention' ? category(session) === 'attention' : ['active','waiting'].includes(category(session))));
  $('rows').replaceChildren(...shown.map(session => {
    const row = element('tr'), title = element('td'), status = element('td'), owner = element('td'), pending = element('td'), updated = element('td'), action = element('td');
    title.append(element('span','document-title',session.title || session.ownerLabel || t('document')),element('span','document-id',session.documentId || '—'));
    const state = stateOf(session); status.append(element('span',`status-pill ${category(session)}`,stateLabel(state)));
    const recoveryLabels = {read_quarantined:['Захват кадра ещё не завершён','Frame capture is still unsettled'],read_cleanup_failed:['Остановка захвата не подтверждена','Capture cleanup is unconfirmed'],cdp_timeout:['Браузер не ответил в срок','The browser did not respond in time']};
    const reason = session.error?.code || session.reason || recoveryLabels[session.recovery?.phase]?.[language === 'ru' ? 0 : 1] || session.recovery?.phase || session.lastAction || session.method;
    if (reason) status.append(element('span','detail',reason));
    if (session.error?.message) status.append(element('span','detail',session.error.message));
    owner.append(element('span','profile-name',session.profileId === 'claude' ? 'Claude' : session.profileId === 'codex' ? 'Codex' : session.profileId || '—'),element('span','owner-label',session.ownerLabel || t('unassigned')));
    if (session.browserInstanceId) owner.append(element('span','detail',`${t('browser')}: ${session.browserInstanceId.slice(0,12)}`));
    owner.append(element('span','detail',`${t('session')}: ${(session.sessionId || session.id || '—').slice(0,12)}`));
    pending.textContent = Number.isFinite(session.pending) ? String(session.pending) : '—'; pending.title = t('pendingCount');
    updated.append(element('span',`time ${state === 'stale' ? 'stale-time' : ''}`,age(session.updatedAt)));
    const runtime = session.runtime?.host?.version || session.runtime?.version;
    if (runtime) { const version = element('span','detail',`${t('runtime')} ${runtime}`); version.title = `Host: ${session.runtime?.host?.buildId || '—'}; Extension: ${session.runtime?.extension?.version || '—'} (${session.runtime?.extension?.buildId || '—'})`; updated.append(version); }
    const button = element('button','row-action',t(session.paused ? 'resume' : 'pause')); button.type = 'button'; button.disabled = !enabled || state === 'stale' || state === 'disconnected'; button.ariaLabel = `${t(session.paused ? 'resume' : 'pause')}: ${session.ownerLabel || session.documentId || t('document')}`; button.addEventListener('click',()=>changePolicy({sessionId:session.sessionId || session.id,paused:!session.paused})); action.append(button);
    row.append(title,status,owner,pending,updated,action); return row;
  }));
  $('empty').hidden = shown.length > 0; document.querySelector('.table-scroll').hidden = shown.length === 0;
  $('empty-title').textContent = t(sessions.length ? 'filteredTitle' : 'emptyTitle'); $('empty-description').textContent = t(sessions.length ? 'filteredDescription' : 'emptyDescription');
  const jobs = latest?.jobs?.records || [];
  $('exports').hidden = !jobs.length && latest?.jobs?.status !== 'partial';
  $('export-count').textContent = String(jobs.length);
  $('exports-notice').hidden = latest?.jobs?.status !== 'partial'; $('exports-notice').textContent = t('exportsUnavailable');
  $('export-rows').replaceChildren(...jobs.map(job=>{
    const row = element('tr'), doc = element('td'), stage = element('td'), profile = element('td'), updated = element('td');
    const attached = sessions.find(session=>session.documentId === job.documentId);
    doc.append(element('span','document-title',attached?.title || attached?.ownerLabel || job.documentId || t('document')),element('span','document-id',job.jobId));
    const label = exportStages[job.stage]?.[language === 'ru' ? 0 : 1] || job.stage || job.state;
    const group = ['failed','needs_reconciliation'].includes(job.state) ? 'attention' : job.state === 'succeeded' ? 'active' : ['cancelled','queued'].includes(job.state) || job.stage === 'waiting_for_local_capacity' ? 'paused' : 'waiting';
    stage.append(element('span',`status-pill ${group}`,label));
    if(job.cancelRequested)stage.append(element('span','detail',t('cancelPending')));
    if(job.issueCode)stage.append(element('span','detail',job.issueCode));
    if(job.hasVerifiedFile)stage.append(element('span','detail',t('verifiedFile')));
    profile.textContent = job.profileId === 'claude' ? 'Claude' : 'Codex'; updated.textContent = age(job.updatedAt);
    row.append(doc,stage,profile,updated);return row;
  }));
}
async function api(path, options = {}) {
  const response = await fetch(path, {cache:'no-store',...options,headers:{Authorization:`Bearer ${capability}`,'X-Vids-Monitor':'1',...(options.headers || {})}});
  if (!response.ok) throw new Error(response.status === 401 ? 'AUTH' : 'UNAVAILABLE');
  return response.json();
}
async function refresh() {
  if (!capability) { showNotice(t('auth')); render(); return; }
  attempted = true;
  try { latest = await api('/api/snapshot'); healthy = true; if (!busy) showNotice(''); }
  catch (error) { healthy = false; showNotice(t(error.message === 'AUTH' ? 'auth' : 'failed')); }
  render(); clearTimeout(timer); timer = setTimeout(refresh, document.hidden ? 15000 : 3000);
}
async function changePolicy(policy) {
  if (busy || !healthy) return; busy = true; render();
  try { const result = await api('/api/policy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(policy)}); latest = result.snapshot; healthy = true; showNotice(''); }
  catch { healthy = false; showNotice(t('controlFailed')); }
  finally { busy = false; render(); }
}
$('language').addEventListener('click',()=>{ language = language === 'ru' ? 'en' : 'ru'; localStorage.setItem('vids-monitor-language',language); updateLanguage(); if (!capability) showNotice(t('auth')); });
$('pause-all').addEventListener('click',()=>changePolicy({paused:!latest?.policy?.paused}));
$('apply-limit').addEventListener('click',()=>{ if ($('max-concurrency').reportValidity()) changePolicy({maxConcurrency:Number($('max-concurrency').value)}); });
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click',()=>{ filter = button.dataset.filter; for (const item of document.querySelectorAll('[data-filter]')) item.ariaPressed = String(item === button); render(); });
document.addEventListener('visibilitychange',()=>{ clearTimeout(timer); timer = setTimeout(refresh,document.hidden ? 15000 : 0); });
updateLanguage(); void refresh();
