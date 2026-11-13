"use strict";

function createHotkeyController({ shortcuts, initial, toggle, text = (_ru, en) => en, platform = process.platform }) {
  let active = initial, registered = false, pending = null;
  const identity = shortcut => {
    const parts = shortcut.split("+"), key = parts.pop().toLowerCase();
    const modifiers = parts.map(value => value === "CommandOrControl" ? platform === "darwin" ? "Command" : "Control"
      : ["Meta", "Super"].includes(value) ? platform === "darwin" ? "Command" : "Super" : value).sort();
    return [...modifiers, key].join("+");
  };
  const callback = shortcut => () => { if (registered && identity(active) === identity(shortcut)) toggle(); };
  function register() {
    if (registered) return true;
    registered = shortcuts.register(active, callback(active));
    return registered;
  }
  function prepare(shortcut) {
    if (pending) throw new Error("A shortcut change is already in progress");
    if (identity(shortcut) === identity(active)) return { commit() { active = shortcut; }, rollback() {} };
    let reserved = false, finished = false;
    try { reserved = shortcuts.register(shortcut, callback(shortcut)); } catch { /* Invalid Electron accelerator. */ }
    if (!reserved) throw Object.assign(new Error(text(
      "Эта горячая клавиша уже занята. Выберите другое сочетание.", "This shortcut is already in use. Choose another shortcut.")), { code: "hotkey_unavailable" });
    pending = shortcut;
    const finish = commit => {
      if (finished) return;
      finished = true; pending = null;
      if (commit) {
        if (registered) shortcuts.unregister(active);
        active = shortcut; registered = true;
      } else shortcuts.unregister(shortcut);
    };
    return { commit: () => finish(true), rollback: () => finish(false) };
  }
  return { register, prepare, get: () => active };
}
module.exports = { createHotkeyController };
