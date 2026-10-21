import test from "node:test";
import assert from "node:assert/strict";
import {attributes, isFileInput, isPassword, keyEvent, parseVidsUrl, point, validateEditorShortcut} from "./helpers.js";

test("only exact HTTPS Google Vids document URLs enter the bridge", () => {
  assert.equal(parseVidsUrl("https://docs.google.com/videos/d/abc_12-DEF/edit?pli=1#scene=id.p").documentId, "abc_12-DEF");
  for (const url of [
    "https://docs.google.com/document/d/example/edit", "http://docs.google.com/videos/d/abc/edit",
    "https://docs.google.com.evil.test/videos/d/abc/edit", "https://user:password@docs.google.com/videos/d/abc/edit",
    "https://docs.google.com:8443/videos/d/abc/edit", "https://docs.google.com/videos/d/",
    "https://docs.google.com/videos/d/a%2Fb/edit", "javascript:alert(1)", "file:///tmp/video.html",
  ]) assert.equal(parseVidsUrl(url), null, url);
});

test("keyboard shortcuts stay layout-independent and Unicode uses text insertion", () => {
  assert.deepEqual(keyEvent("a", ["Control"]), {key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2});
  assert.equal(keyEvent("z", ["Control", "Shift"]).key, "Z");
  assert.equal(keyEvent("Enter").text, "\r");
  assert.equal(keyEvent("ArrowLeft", ["Shift"]).modifiers, 8);
  assert.equal(keyEvent("a", ["Control", "Control"]).modifiers, 2);
  assert.throws(() => keyEvent("я"), {code: "INVALID_ARGUMENT"});
  assert.throws(() => keyEvent("x", ["Super"]), {code: "INVALID_ARGUMENT"});
  assert.throws(() => keyEvent("F12"), {code: "INVALID_ARGUMENT"});
});

test("clipboard shortcuts are denied even with mixed casing or additional modifiers", () => {
  for (const command of ["Control", "Meta"]) {
    for (const key of ["c", "C", "x", "X", "v", "V", "Insert"]) {
      for (const modifiers of [[command], [command, "Shift"], [command, "Alt"]]) {
        assert.throws(() => validateEditorShortcut(key, modifiers), {code: "FORBIDDEN_SHORTCUT"}, `${modifiers}+${key}`);
        assert.throws(() => keyEvent(key, modifiers), {code: "FORBIDDEN_SHORTCUT"});
      }
    }
  }
  for (const key of ["Insert", "Delete"]) {
    assert.throws(() => validateEditorShortcut(key, ["Shift"]), {code: "FORBIDDEN_SHORTCUT"});
  }
});

test("browser and OS accelerators cannot enter the tab driver", () => {
  for (const command of ["Control", "Meta"]) {
    for (const key of ["l", "t", "n", "w", "q", "r", "p", "o", "s", "f", "d", "e", "h", "j", "k", "u", "Tab", "PageUp", "PageDown", ..."0123456789"]) {
      for (const modifiers of [[command], [command, "Shift"]]) {
        assert.throws(() => validateEditorShortcut(key, modifiers), {code: "FORBIDDEN_SHORTCUT"}, `${modifiers}+${key}`);
      }
    }
    for (const key of ["a", "b", "i", "u", "Delete"]) {
      assert.throws(() => validateEditorShortcut(key, [command, "Shift"]), {code: "FORBIDDEN_SHORTCUT"});
    }
  }
  for (const key of ["Tab", "F4", "Space", "ArrowLeft", "ArrowRight", "Home"]) {
    assert.throws(() => validateEditorShortcut(key, ["Alt"]), {code: "FORBIDDEN_SHORTCUT"});
  }
  assert.throws(() => validateEditorShortcut("a", ["Control", "Meta"]), {code: "FORBIDDEN_SHORTCUT"});
});

test("editor navigation, selection, undo, redo, bold and italic remain available", () => {
  for (const key of ["Enter", "Escape", "Delete", "Backspace", "Tab", "Space", "Home", "End", "PageUp", "PageDown", "ArrowLeft", "ArrowRight"]) {
    assert.equal(typeof validateEditorShortcut(key), "number", key);
  }
  for (const command of ["Control", "Meta"]) {
    for (const key of ["a", "A", "z", "Z", "y", "b", "i", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) {
      assert.doesNotThrow(() => keyEvent(key, [command]), `${command}+${key}`);
    }
    for (const key of ["z", "Z", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) {
      assert.doesNotThrow(() => keyEvent(key, [command, "Shift"]), `${command}+Shift+${key}`);
    }
  }
  assert.doesNotThrow(() => keyEvent("Tab", ["Shift"]));
  assert.doesNotThrow(() => keyEvent("Enter", ["Shift"]));
  assert.doesNotThrow(() => keyEvent("ArrowLeft", ["Shift"]));
});

test("coordinates reject pixels outside CSS viewport", () => {
  assert.deepEqual(point({x: 120, y: 40}, {width: 800, height: 600}), {x: 120, y: 40});
  for (const x of [-1, NaN, Infinity, 800, "120"]) assert.throws(() => point({x, y: 0}, {width: 800, height: 600}));
});

test("password and file controls are classified from actual DOM attributes", () => {
  const password = {nodeName: "INPUT", attributes: ["type", "password", "value", "do-not-expose"]};
  assert.equal(isPassword(password), true);
  assert.equal(isPassword({nodeName: "TEXTAREA", attributes: ["type", "password"]}), false);
  assert.equal(isFileInput({nodeName: "INPUT", attributes: ["type", "file"]}), true);
  assert.equal(attributes(password).type, "password");
});
