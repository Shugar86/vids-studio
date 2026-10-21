// Receipts contain attachment metadata only; never ownership tokens or page data.
const KEY = 'vidsStudioFencesV1';
const LIMIT = 64;
const ACTIVE = 'vidsStudioActiveBindingV1';

export function requireStorage(chromeApi) {
  const storage = chromeApi.storage?.local;
  if (!storage || !['get', 'set', 'remove'].every(name => typeof storage[name] === 'function')) {
    const error = new Error('Durable attachment storage is unavailable. Reload the updated extension with its storage permission.');
    error.code = 'STORAGE_REQUIRED';
    throw error;
  }
  return storage;
}

export async function rememberBinding(chromeApi, binding) {
  await requireStorage(chromeApi).set({[ACTIVE]: binding});
}

export async function clearBinding(chromeApi, sessionId) {
  requireStorage(chromeApi);
  const active = (await chromeApi.storage.local.get(ACTIVE))[ACTIVE];
  if (active?.sessionId === sessionId) await chromeApi.storage.local.remove(ACTIVE);
}

// Only invoked by a new explicit popup attachment. Inspect/revoke precisely the
// persisted prior binding; never discover or attach any other browser target.
export async function recoverBinding(chromeApi, profileId) {
  requireStorage(chromeApi);
  const active = (await chromeApi.storage.local.get(ACTIVE))[ACTIVE];
  if (!active) return;
  if (active.profileId !== profileId || !Number.isInteger(active.tabId) ||
      typeof active.sessionId !== 'string' || typeof active.documentId !== 'string') {
    throw new Error('Invalid stored attachment; inspect extension storage before reconnecting.');
  }
  try { await chromeApi.debugger.detach({tabId: active.tabId}); }
  catch (error) {
    // Exact Chromium API constants, including the known target id. Any other
    // error leaves recovery blocked; it is never evidence of a successful fence.
    const allowed = [`Debugger is not attached to the tab with id: ${active.tabId}.`,
      `No tab with given id ${active.tabId}.`];
    if (!allowed.includes(error?.message)) throw new Error('Could not fence the prior attachment. Close its old Vids tab and explicitly reconnect.');
  }
  await recordFence(chromeApi, {profileId, sessionId: active.sessionId, documentId: active.documentId});
  await clearBinding(chromeApi, active.sessionId);
}

export async function readFences(chromeApi) {
  requireStorage(chromeApi);
  const stored = (await chromeApi.storage.local.get(KEY))[KEY];
  return Array.isArray(stored) ? stored.filter(item => item && item.fenced === true &&
    typeof item.profileId === 'string' && typeof item.sessionId === 'string' &&
    typeof item.documentId === 'string' && Number.isFinite(item.fencedAt)).slice(-LIMIT) : [];
}

export async function recordFence(chromeApi, binding) {
  requireStorage(chromeApi);
  const receipts = (await readFences(chromeApi)).filter(item => item.sessionId !== binding.sessionId);
  receipts.push({...binding, fenced: true, fencedAt: Date.now()});
  const bounded = receipts.slice(-LIMIT);
  await chromeApi.storage.local.set({[KEY]: bounded});
  return bounded;
}
