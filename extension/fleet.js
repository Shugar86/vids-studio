import {createDriver} from './driver.js';
import {fail, parseVidsUrl} from './helpers.js';

const INSTANCE_KEY = 'vidsStudioBrowserInstanceV1';
const MAX_ATTACHMENTS = 256; // Registry bound, not a promise of hardware capacity.

function newTicket() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}

// A profile-local browser lifetime identity. No pairing capability is persisted.
async function instanceId(chromeApi) {
  const storage = chromeApi.storage?.session;
  if (!storage?.get || !storage?.set) return crypto.randomUUID();
  const current = (await storage.get(INSTANCE_KEY))[INSTANCE_KEY];
  if (typeof current === 'string' && /^[a-zA-Z0-9-]{16,128}$/.test(current)) return current;
  const value = crypto.randomUUID();
  await storage.set({[INSTANCE_KEY]: value});
  return value;
}

export function createFleetDriver(chromeApi, {driverFactory = createDriver} = {}) {
  const records = new Map();
  const attaching = new Set();
  let browserInstanceId;
  const ready = instanceId(chromeApi).then(value => { browserInstanceId = value; return value; });

  function recordForSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) fail('SESSION_REQUIRED', 'Select the exact attached session.');
    const record = [...records.values()].find(item => item.ready && item.driver.status().sessionId === sessionId);
    if (!record) fail('SESSION_MISMATCH', 'This session is not attached to this extension. Refresh the connections list.');
    return record;
  }

  async function status(tabId) {
    await ready;
    const sessions = [...records.values()].filter(record => record.ready).map(record => ({...record.driver.status(),
      pairingState: record.ticket ? 'available' : 'claimed'})).filter(item => item.attached);
    return {browserInstanceId, attached: sessions.length > 0, sessions,
      currentSessionId: sessions.find(item => item.tabId === tabId)?.sessionId ?? null};
  }

  async function attach(tab) {
    await ready;
    if (!Number.isInteger(tab?.id) || !parseVidsUrl(tab.url)) fail('WRONG_PAGE', 'Откройте документ Google Vids: docs.google.com/videos/d/…');
    if (attaching.has(tab.id)) fail('BUSY', 'This tab attachment is already in progress.');
    const existing = records.get(tab.id);
    if (existing?.driver.status().attached) return {status: await status(tab.id), pairing: pairing(existing.driver.status().sessionId)};
    if (existing) fail('BROWSER_RECOVERING', 'This tab is still detaching. Other connected tabs remain available.');
    if (records.size >= MAX_ATTACHMENTS) fail('FLEET_CAPACITY', 'The attachment registry is full. Disconnect unused sessions.');
    attaching.add(tab.id);
    const record = {driver: null, ticket: newTicket(), ready: false};
    record.driver = driverFactory(chromeApi, {
      fleet: {browserInstanceId, pairingTicket: record.ticket},
      onPairingClaimed: () => { record.ticket = null; },
      onDetached: () => {
        if (records.get(tab.id) === record) records.delete(tab.id);
        record.ticket = null;
        record.driver.dispose();
      },
    });
    records.set(tab.id, record);
    try {
      await record.driver.attach(tab);
      record.ready = true;
      return {status: await status(tab.id), pairing: pairing(record.driver.status().sessionId)};
    } catch (error) {
      if (records.get(tab.id) === record) records.delete(tab.id);
      record.ticket = null;
      record.driver.dispose();
      throw error;
    } finally { attaching.delete(tab.id); }
  }

  // Popup-only capability reveal. Never included in status, diagnostics, events,
  // download metadata, or any MCP discovery response.
  function pairing(sessionId) {
    const record = recordForSession(sessionId);
    const current = record.driver.status();
    return {sessionId, browserInstanceId, documentId: current.documentId,
      ticket: record.ticket, state: record.ticket ? 'available' : 'claimed'};
  }

  async function detach(sessionId) {
    const record = recordForSession(sessionId);
    await record.driver.detach();
    return status();
  }

  function handleRequest(request) {
    return recordForSession(request?.sessionId).driver.handleRequest(request);
  }
  function onDebuggerEvent(source, method, params) { records.get(source.tabId)?.driver.onDebuggerEvent(source, method, params); }
  function onDebuggerDetach(source, reason) { records.get(source.tabId)?.driver.onDebuggerDetach(source, reason); }
  function onTabUpdated(tabId, changeInfo) { records.get(tabId)?.driver.onTabUpdated(tabId, changeInfo); }
  function onTabRemoved(tabId) { records.get(tabId)?.driver.onTabRemoved(tabId); }
  return {ready, status, attach, detach, pairing, handleRequest, onDebuggerEvent, onDebuggerDetach, onTabUpdated, onTabRemoved};
}
