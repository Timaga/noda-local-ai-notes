(function (root) {
  "use strict";
  function format(value, start, end, command) {
    const wrappers = { bold: ["**", "**"], italic: ["*", "*"], strike: ["~~", "~~"], code: ["`", "`"] };
    let before = value.slice(0, start), selected = value.slice(start, end), after = value.slice(end);
    if (wrappers[command]) {
      const [left, right] = wrappers[command];
      if (before.endsWith(left) && after.startsWith(right)) {
        return { value: before.slice(0, -left.length) + selected + after.slice(right.length), start: start - left.length, end: end - left.length };
      }
      return { value: before + left + selected + right + after, start: start + left.length, end: end + left.length };
    }
    const prefixes = { paragraph: "", h1: "# ", h2: "## ", h3: "### ", bullet: "- ", numbered: "1. ", task: "- [ ] ", quote: "> " };
    if (!Object.hasOwn(prefixes, command)) return { value, start, end };
    const first = start === 0 ? 0 : value.lastIndexOf("\n", start - 1) + 1;
    const selectionEnd = end > start && value[end - 1] === "\n" ? end - 1 : end;
    let last = value.indexOf("\n", selectionEnd);
    if (last < 0) last = value.length;
    const lines = value.slice(first, last).split("\n");
    const prefix = prefixes[command];
    const replacement = lines.map((line, index) => {
      const clean = line.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s*)?|\d+\.\s+)/, "");
      return (command === "numbered" ? `${index + 1}. ` : prefix) + clean;
    }).join("\n");
    return { value: value.slice(0, first) + replacement + value.slice(last), start: first, end: first + replacement.length };
  }
  function shortcut(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return null;
    const code = event.code || (typeof event.key === "string" ? `Key${event.key.toUpperCase()}` : "");
    return { KeyB: "bold", KeyI: "italic", KeyK: "link", KeyS: "save" }[code] || null;
  }
  function linkAddress(value) {
    if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
    try {
      const address = new URL(value);
      if (!["http:", "https:", "mailto:"].includes(address.protocol) || address.username || address.password) return null;
      if (address.protocol === "mailto:" ? !address.pathname : !address.hostname) return null;
      return address.href;
    } catch { return null; }
  }
  function insertLink(value, start, end, address) {
    const target = linkAddress(address);
    if (!target) return null;
    const label = (value.slice(start, end) || target).replace(/[\\[\]]/g, "\\$&");
    const inserted = `[${label}](<${target}>)`;
    return { value: value.slice(0, start) + inserted + value.slice(end), start: start + 1, end: start + 1 + label.length };
  }
  const api = { format, shortcut, linkAddress, insertLink };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NotesEditorCommands = api;
})(typeof window === "undefined" ? globalThis : window);
