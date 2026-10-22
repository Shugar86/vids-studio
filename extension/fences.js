// Receipts contain attachment metadata only; never ownership tokens or page data.
const KEY = 'vidsStudioFencesV1';
const LIMIT = 64;
const BINDINGS_LIMIT = 256;
const LEGACY_ACTIVE = 'vidsStudioActiveBindingV1';
const ACTIVE = 'vidsStudioActiveBindingsV2';
const storageQueues = new WeakMap();

export function requireStorage(chromeApi) {
  const storage = chromeApi.storage?.local;
  if (!storage || !['get', 'set', 'remove'].every(name => typeof storage[name] === 'function')) {
    const error = new Error('Durable attachment storage is unavailable. Reload the updated extension with its storage permission.');
    error.code = 'STORAGE_REQUIRED';
    throw error;
  }
  return storage;
}

// Serialise only small storage transactions. A slow debugger detach must never
// hold the registry lock or stall attachment/storage for unrelated documents.
function transaction(chromeApi, action) {
  const storage = requireStorage(chromeApi);
  const result = (storageQueues.get(storage) || Promise.resolve()).then(() => action(storage));
  storageQueues.set(storage, result.catch(() => {}));
  return result;
}

function validBinding(binding) {
  return binding && typeof binding === 'object' && typeof binding.profileId === 'string' &&
    Number.isInteger(binding.tabId) && typeof binding.sessionId === 'string' &&
    typeof binding.documentId === 'string';
}

async function bindings(storage) {
  const value = (await storage.get(ACTIVE))[ACTIVE];
  if (value !== undefined && (!Array.isArray(value) || value.some(item => !validBinding(item)))) {
    throw new Error('Invalid stored attachments; inspect extension storage before reconnecting.');
  }
  const active = value || [];
  const legacy = (await storage.get(LEGACY_ACTIVE))[LEGACY_ACTIVE];
  if (legacy !== undefined) {
    if (!validBinding(legacy)) throw new Error('Invalid stored attachment; inspect extension storage before reconnecting.');
    if (!active.some(item => item.sessionId === legacy.sessionId)) active.push(legacy);
    await storage.set({[ACTIVE]: active});
    await storage.remove(LEGACY_ACTIVE);
  }
  return active;
}

export function rememberBinding(chromeApi, binding) {
  return transaction(chromeApi, async storage => {
    if (!validBinding(binding)) throw new Error('Invalid attachment binding');
    const active = (await bindings(storage)).filter(item => item.sessionId !== binding.sessionId);
    if (active.length >= BINDINGS_LIMIT) throw new Error('Attachment registry is full; recover stale attachments before connecting more tabs.');
    active.push({profileId: binding.profileId, tabId: binding.tabId, sessionId: binding.sessionId,
      documentId: binding.documentId, ...(binding.browserInstanceId ? {browserInstanceId: binding.browserInstanceId} : {})});
    await storage.set({[ACTIVE]: active});
  });
}

export function clearBinding(chromeApi, sessionId) {
  return transaction(chromeApi, async storage => {
    const active = (await bindings(storage)).filter(item => item.sessionId !== sessionId);
    if (active.length) await storage.set({[ACTIVE]: active});
    else await storage.remove(ACTIVE);
  });
}

// Explicit attachment recovers only the chosen tab. The optional legacy mode
// supports the single-driver API; it refuses ambiguity instead of revoking a fleet.
export async function recoverBinding(chromeApi, profileId, tabId) {
  const all = await transaction(chromeApi, storage => bindings(storage));
  const selected = tabId === undefined ? all : all.filter(item => item.tabId === tabId);
  if (tabId === undefined && selected.length > 1) throw new Error('Multiple stored attachments; select the tab to recover.');
  for (const active of selected) {
    if (active.profileId !== profileId) throw new Error('Invalid stored attachment; inspect extension storage before reconnecting.');
    try { await chromeApi.debugger.detach({tabId: active.tabId}); }
    catch (error) {
      const allowed = [`Debugger is not attached to the tab with id: ${active.tabId}.`, `No tab with given id ${active.tabId}.`];
      if (!allowed.includes(error?.message)) throw new Error('Could not fence the prior attachment. Close its old Vids tab and explicitly reconnect.');
    }
    await recordFence(chromeApi, active);
    await clearBinding(chromeApi, active.sessionId);
  }
}

function receipts(value) {
  return Array.isArray(value) ? value.filter(item => item && item.fenced === true &&
    typeof item.profileId === 'string' && typeof item.sessionId === 'string' &&
    typeof item.documentId === 'string' && Number.isFinite(item.fencedAt)).slice(-LIMIT) : [];
}

export function readFences(chromeApi) {
  return transaction(chromeApi, async storage => receipts((await storage.get(KEY))[KEY]));
}

export function recordFence(chromeApi, binding) {
  return transaction(chromeApi, async storage => {
    const stored = receipts((await storage.get(KEY))[KEY]).filter(item => item.sessionId !== binding.sessionId);
    stored.push({profileId: binding.profileId, sessionId: binding.sessionId, documentId: binding.documentId,
      ...(binding.browserInstanceId ? {browserInstanceId: binding.browserInstanceId} : {}), fenced: true, fencedAt: Date.now()});
    const bounded = stored.slice(-LIMIT);
    await storage.set({[KEY]: bounded});
    return bounded;
  });
}
