export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

export function fail(code, message) {
  throw new BridgeError(code, message);
}

export function parseVidsUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "docs.google.com" ||
        url.port || url.username || url.password) return null;
    const match = /^\/videos\/d\/([A-Za-z0-9_-]+)(?:\/[^?#]*)?$/.exec(url.pathname);
    return match ? {documentId: match[1], url: url.href} : null;
  } catch {
    return null;
  }
}

export function plainObject(value, label = "params") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_ARGUMENT", `${label} must be an object.`);
  }
  return value;
}

export function finiteNumber(value, label, min = -1e7, max = 1e7) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail("INVALID_ARGUMENT", `${label} must be a finite number between ${min} and ${max}.`);
  }
  return value;
}

export function integer(value, label, min, max) {
  finiteNumber(value, label, min, max);
  if (!Number.isInteger(value)) fail("INVALID_ARGUMENT", `${label} must be an integer.`);
  return value;
}

export function string(value, label, max = 10000, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value.length) || value.length > max) {
    fail("INVALID_ARGUMENT", `${label} must be ${allowEmpty ? "a" : "a nonempty"} string of at most ${max} characters.`);
  }
  return value;
}

export function point(value, viewport, label = "point") {
  plainObject(value, label);
  return {
    x: finiteNumber(value.x, `${label}.x`, 0, Math.max(0, viewport.width - 0.01)),
    y: finiteNumber(value.y, `${label}.y`, 0, Math.max(0, viewport.height - 0.01)),
  };
}

const NAMED_KEYS = {
  Enter: ["Enter", 13], Tab: ["Tab", 9], Escape: ["Escape", 27],
  Backspace: ["Backspace", 8], Delete: ["Delete", 46],
  ArrowLeft: ["ArrowLeft", 37], ArrowUp: ["ArrowUp", 38],
  ArrowRight: ["ArrowRight", 39], ArrowDown: ["ArrowDown", 40],
  Home: ["Home", 36], End: ["End", 35],
  PageUp: ["PageUp", 33], PageDown: ["PageDown", 34],
  Space: ["Space", 32],
};
const MODIFIERS = {Alt: 1, Control: 2, Meta: 4, Shift: 8};
const EDITOR_COMMAND_KEYS = new Set([
  "a", "z", "y", "b", "i", "Backspace", "Delete",
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End",
]);
const EDITOR_SHIFT_COMMAND_KEYS = new Set([
  "z", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End",
]);

// Shared by the extension and MCP server, so the server can enforce this
// boundary before an already-loaded older extension receives any input.
// Return the validated CDP modifier mask; never expand into OS key events.
export function validateEditorShortcut(key, modifiers = []) {
  string(key, "key", 30);
  if (!Array.isArray(modifiers) || modifiers.length > 4 ||
      modifiers.some(value => !Object.hasOwn(MODIFIERS, value))) {
    fail("INVALID_ARGUMENT", "modifiers must contain only Alt, Control, Meta, Shift.");
  }
  const mask = [...new Set(modifiers)].reduce((result, name) => result | MODIFIERS[name], 0);
  const normalizedKey = /^[A-Za-z]$/.test(key) ? key.toLowerCase() : key;
  const command = mask & (MODIFIERS.Control | MODIFIERS.Meta);
  const shifted = Boolean(mask & MODIFIERS.Shift);
  const allowed = !(mask & MODIFIERS.Alt) && command !== (MODIFIERS.Control | MODIFIERS.Meta) &&
    (command ? (shifted ? EDITOR_SHIFT_COMMAND_KEYS : EDITOR_COMMAND_KEYS).has(normalizedKey) :
      !(shifted && ["Insert", "Delete"].includes(normalizedKey)));
  if (!allowed) {
    fail("FORBIDDEN_SHORTCUT", "This shortcut is outside the editor allowlist. Clipboard, browser and system shortcuts are disabled; use the observed Vids interface.");
  }
  if (!Object.hasOwn(NAMED_KEYS, key) && !/^[A-Za-z0-9]$/.test(key)) {
    fail("INVALID_ARGUMENT", "Use a named navigation key, ASCII letter or digit. Use type_text for Unicode text.");
  }
  return mask;
}

export function keyEvent(key, modifiers = []) {
  const mask = validateEditorShortcut(key, modifiers);
  let code, windowsVirtualKeyCode, eventKey = key;
  if (Object.hasOwn(NAMED_KEYS, key)) {
    [code, windowsVirtualKeyCode] = NAMED_KEYS[key];
    if (key === "Space") eventKey = " ";
  } else if (/^[a-zA-Z]$/.test(key)) {
    code = `Key${key.toUpperCase()}`;
    windowsVirtualKeyCode = key.toUpperCase().charCodeAt(0);
    eventKey = mask & 8 ? key.toUpperCase() : key.toLowerCase();
  } else if (/^[0-9]$/.test(key)) {
    code = `Digit${key}`;
    windowsVirtualKeyCode = key.charCodeAt(0);
  } else {
    fail("INVALID_ARGUMENT", "Use a named navigation key, ASCII letter or digit. Use type_text for Unicode text.");
  }
  const event = {key: eventKey, code, windowsVirtualKeyCode, modifiers: mask};
  // Browser edit controls need text on keyDown for Enter/Tab/Space. Shortcuts do not.
  if (!(mask & (1 | 2 | 4))) {
    if (key === "Enter") event.text = "\r";
    else if (key === "Tab") event.text = "\t";
    else if (key === "Space") event.text = " ";
    else if (/^[a-zA-Z0-9]$/.test(key)) event.text = eventKey;
  }
  return event;
}

export function attributes(node) {
  const result = {};
  const values = node?.attributes || [];
  for (let i = 0; i < values.length; i += 2) result[values[i].toLowerCase()] = values[i + 1];
  return result;
}

export function isPassword(node) {
  return node?.nodeName?.toLowerCase() === "input" && attributes(node).type?.toLowerCase() === "password";
}

export function isFileInput(node) {
  return node?.nodeName?.toLowerCase() === "input" && attributes(node).type?.toLowerCase() === "file";
}

export function safeError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "BROWSER_ERROR",
    message: String(error?.message || "Unknown browser error").slice(0, 1200),
  };
}
