import {createFleetDriver} from './fleet.js';
import {safeError} from './helpers.js';

const fleet = createFleetDriver(chrome);
chrome.debugger.onEvent.addListener(fleet.onDebuggerEvent);
chrome.debugger.onDetach.addListener(fleet.onDebuggerDetach);
chrome.tabs.onUpdated.addListener(fleet.onTabUpdated);
chrome.tabs.onRemoved.addListener(fleet.onTabRemoved);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the extension's own popup can grant attachment, reveal a one-use
  // pairing capability, or disconnect an explicitly selected session.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  const action = async () => {
    if (message?.type === 'status') {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      return fleet.status(tab?.id);
    }
    if (message?.type === 'disconnect') return fleet.detach(message.sessionId);
    if (message?.type === 'pairing') return fleet.pairing(message.sessionId);
    if (message?.type === 'attach') {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      return fleet.attach(tab);
    }
    throw new Error('Unknown popup action');
  };
  void action().then(result => sendResponse({ok: true, result}), error => sendResponse({ok: false, error: safeError(error)}));
  return true;
});
