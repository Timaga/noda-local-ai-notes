/* Parse Obsidian links as Markdown tokens so code examples remain literal. */
(function () {
  const CHAT_TAGS = new Set([
    "P", "BR", "HR", "STRONG", "EM", "DEL", "UL", "OL", "LI", "BLOCKQUOTE",
    "CODE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD",
  ]);

  function renderChat(source) {
    const marked = window.marked;
    if (!marked?.parse || source.length > 65536) return null;
    try {
      const renderer = new marked.Renderer();
      renderer.html = (html) => html.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      renderer.link = (_href, _title, label) => label;
      renderer.image = (_href, _title, alt) => alt;
      renderer.checkbox = (checked) => checked ? "☑ " : "☐ ";
      const template = document.createElement("template");
      template.innerHTML = marked.parse(source, { renderer, breaks: true, gfm: true, headerIds: false, mangle: false });
      // Model output gets formatting elements only. Source navigation uses the verified buttons below it.
      for (const node of template.content.querySelectorAll("*")) {
        if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || !CHAT_TAGS.has(node.tagName)) {
          node.replaceWith(document.createTextNode(node.textContent));
          continue;
        }
        for (const { name, value } of Array.from(node.attributes)) {
          if (node.tagName === "OL" && name === "start" && /^\d{1,9}$/.test(value)) continue;
          node.removeAttribute(name);
        }
      }
      return template.content;
    } catch {
      return null;
    }
  }

  function validMetadataItems(values) {
    return Array.isArray(values) && values.every(item => typeof item === "string"
      && item.trim() && item === item.trim() && !/[\u0000-\u001f\u007f]/.test(item))
      && new Set(values).size === values.length;
  }

  function validRuTags(tags) {
    return validMetadataItems(tags) && tags.every(tag => Array.from(tag).length <= 80
      && /^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u.test(tag) && /\p{L}/u.test(tag));
  }

  function presentation(markdownText) {
    const original = String(markdownText ?? "");
    const fallback = { source: original, related: [], title: null, tags: null };
    const match = /^---\r?\n([\s\S]*?)^---\r?\n/m.exec(original);
    if (!match || match.index !== 0) return fallback;
    const values = new Map();
    for (const line of match[1].replace(/\r?\n$/, "").split(/\r?\n/)) {
      const entry = /^([a-z_][a-z0-9_]*):[ \t]*(.*)$/.exec(line);
      if (!entry || values.has(entry[1])) return fallback;
      values.set(entry[1], entry[2]);
    }
    const keys = ["title", "tags", "related", "noda_source_version", "noda_source_sha256", "noda_source_length"];
    if (values.size !== keys.length || keys.some((key) => !values.has(key))) return fallback;
    try {
      const version = JSON.parse(values.get("noda_source_version"));
      if (!["faithful-v1", "ru-pipeline-v1"].includes(version)) return fallback;
      const title = JSON.parse(values.get("title"));
      const tags = JSON.parse(values.get("tags"));
      const related = JSON.parse(values.get("related"));
      const hash = JSON.parse(values.get("noda_source_sha256"));
      const length = values.get("noda_source_length");
      const source = original.slice(match[0].length);
      if (typeof title !== "string" || !title || !Array.isArray(tags)
          || (version === "faithful-v1" && tags.length)
          || (version === "ru-pipeline-v1" && (!validRuTags(tags) || !validMetadataItems(related)))
          || !Array.isArray(related) || related.some((id) => typeof id !== "string" || !id)
          || new Set(related).size !== related.length || typeof hash !== "string"
          || !/^[a-f0-9]{64}$/.test(hash) || !/^(0|[1-9][0-9]*)$/.test(length)) return fallback;
      // The backend verifies the digest on reading; preview never changes the file.
      return { source, related, title, tags };
    } catch (_) {
      return fallback;
    }
  }

  function noteTarget(target) {
    return String(target || "").split("#", 1)[0].replace(/\.md$/i, "").trim();
  }

  function markdownLocalPath(href) {
    if (!href || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) || href.startsWith("//")) {
      return "";
    }
    try {
      return decodeURIComponent(href.split(/[?#]/, 1)[0]);
    } catch (_) {
      return "";
    }
  }

  function createOptions({ marked, escapeHtml, noteAssetUrl }) {
    const renderer = new marked.Renderer();
    const renderImage = renderer.image.bind(renderer);
    const renderLink = renderer.link.bind(renderer);
    const imageExtension = /\.(png|jpe?g|gif|webp|svg)$/i;

    function internalLink(title, label) {
      return `<a href="#" class="internal-note-link" data-note-title="${escapeHtml(title)}">${label}</a>`;
    }

    renderer.image = function (href, title, text) {
      const localPath = markdownLocalPath(href);
      const src = localPath && imageExtension.test(localPath) ? noteAssetUrl(localPath) : href;
      return renderImage(src, title, text);
    };

    renderer.link = function (href, title, text) {
      const localPath = markdownLocalPath(href);
      if (/\.md$/i.test(localPath)) {
        return internalLink(noteTarget(localPath), text);
      }
      return renderLink(href, title, text);
    };

    function tokenizeWiki(source) {
      const match = /^(!?)\[\[([^\]\n]+)\]\]/.exec(source);
      if (!match) {
        return undefined;
      }
      const [target, ...alias] = match[2].split("|");
      return {
        type: "obsidianReference", raw: match[0], embed: Boolean(match[1]),
        target: target.trim(), label: alias.join("|").trim(),
      };
    }

    function renderWiki(token) {
      if (token.embed) {
        const src = imageExtension.test(token.target) ? noteAssetUrl(token.target) : "";
        if (!src) {
          return escapeHtml(token.raw);
        }
        const label = token.label && !/^\d+(x\d+)?$/i.test(token.label)
          ? token.label : token.target.split(/[\\/]/).pop();
        const fallbackLabel = window.nodaI18n?.t("изображение", "image") ?? "изображение";
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(label || fallbackLabel)}">`;
      }
      const title = noteTarget(token.target);
      return title ? internalLink(title, escapeHtml(token.label || token.target)) : escapeHtml(token.raw);
    }

    return {
      breaks: true, gfm: true, headerIds: false, mangle: false, renderer,
      extensions: {
        inline: [tokenizeWiki],
        startInline: [(source) => source.search(/!?\[\[/)],
        renderers: { obsidianReference: renderWiki },
      },
    };
  }

  window.notesMarkdown = { createOptions, presentation, renderChat };
}());
