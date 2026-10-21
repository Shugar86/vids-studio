import {createDriver} from "./driver.js";
import {safeError} from "./helpers.js";

const driver = createDriver(chrome);
chrome.debugger.onEvent.addListener(driver.onDebuggerEvent);
chrome.debugger.onDetach.addListener(driver.onDebuggerDetach);
chrome.tabs.onUpdated.addListener(driver.onTabUpdated);
chrome.tabs.onRemoved.addListener(driver.onTabRemoved);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only our extension popup can attach or disconnect. There is no content
  // script, externally_connectable endpoint or page message listener.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return false;
  const action = async () => {
    if (message?.type === "status") return driver.status();
    if (message?.type === "disconnect") return driver.detach();
    if (message?.type === "attach") {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      return driver.attach(tab);
    }
    throw new Error("Unknown popup action");
  };
  void action().then(result => sendResponse({ok: true, result}), error => sendResponse({ok: false, error: safeError(error)}));
  return true;
});
