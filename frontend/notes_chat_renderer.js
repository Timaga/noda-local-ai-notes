// Separate renderer for local chat history and note-grounded answers.
(function () {
  const API_BASE = window.quickNoteBridge?.getBackendOrigin?.() || "http://127.0.0.1:5000";
  const CHAT_READY_TIMEOUT_MS = 180000;
  const RAG_REQUEST_TIMEOUT_MS = 600000;
  const CHAT_STORAGE_KEY = "notes-panel-rag-chats-v1";
  const CHAT_CONTEXT_LIMIT = 10;
  const CHAT_HISTORY_CONTEXT_LIMIT = 20;
  const CHAT_QUERY_MAX_CHARS = 800;
  const MAX_STORED_CHATS = 30;
  const MAX_STORED_MESSAGES = 80;
  const t = (ru, en) => window.nodaI18n?.t(ru, en) ?? ru;

  const chatCount = document.getElementById("chat-count");
  const chatNewBtn = document.getElementById("chat-new-btn");
  const chatSearch = document.getElementById("chat-search");
  const chatHistoryList = document.getElementById("chat-history-list");
  const chatTitle = document.getElementById("chat-title");
  const chatSubtitle = document.getElementById("chat-subtitle");
  const chatMenuBtn = document.getElementById("chat-menu-btn");
  const chatMessages = document.getElementById("chat-messages");
  const chatForm = document.getElementById("chat-form");
  const chatInput = document.getElementById("chat-input");
  const chatSendBtn = document.getElementById("chat-send-btn");
  const chatStopBtn = document.getElementById("chat-stop-btn");
  const chatQueryHint = document.getElementById("chat-query-hint");
  const chatStorageHint = document.getElementById("chat-storage-hint");
  const chatExportBtn = document.getElementById("chat-export-btn");

  let chats = [];
  let selectedChatId = "";
  let notesSnapshot = [];
  let qdrantSnapshot = {};
  let sending = false;
  const projectContext = window.NodaProjectContext;
  let boundProject = null;
  let chatEpoch = 0;
  let activeRequest = null;
  let pendingViews = [];
  let historyStorageFailed = false;

  function scopeCurrent(epoch = chatEpoch) {
    return epoch === chatEpoch && boundProject?.status === "ready"
      && (!projectContext || projectContext.isCurrent(boundProject));
  }

  function storageKey() {
    return boundProject?.projectId ? `${CHAT_STORAGE_KEY}:${boundProject.projectId}` : CHAT_STORAGE_KEY;
  }

  function saveSession() {
    if (boundProject?.status !== "ready") return;
    try {
      localStorage.setItem(`${storageKey()}:state`, JSON.stringify({ selectedChatId,
        draft: chatInput?.value || "", search: chatSearch?.value || "", scrollTop: chatHistoryList.scrollTop }));
    } catch (_) {
      // Storage is a convenience cache; the active project remains isolated if it is unavailable.
    }
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function createId(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return `${prefix}-${window.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function getSelectedChat() {
    return chats.find((chat) => chat.id === selectedChatId) || null;
  }

  function createEmptyChat() {
    const timestamp = nowIso();
    return {
      id: createId("chat"),
      title: t("Новый чат", "New chat"),
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [],
    };
  }

  function normalizeChat(candidate) {
    const fallback = createEmptyChat();
    const messages = Array.isArray(candidate && candidate.messages) ? candidate.messages : [];
    return {
      id: String((candidate && candidate.id) || fallback.id),
      title: String((candidate && candidate.title) || fallback.title).slice(0, 120),
      createdAt: String((candidate && candidate.createdAt) || fallback.createdAt),
      updatedAt: String((candidate && candidate.updatedAt) || fallback.updatedAt),
      messages: messages.slice(-MAX_STORED_MESSAGES).map(normalizeMessage).filter(Boolean),
    };
  }

  function normalizeMessage(message) {
    if (!message || !["user", "assistant"].includes(message.role)) return null;
    return {
      id: String(message.id || createId("msg")),
      role: message.role,
      text: String(message.text || ""),
      createdAt: String(message.createdAt || nowIso()),
      pending: Boolean(message.pending),
      errorCode: typeof message.errorCode === "string" ? message.errorCode.slice(0, 40) : "",
      error: Boolean(message.error),
      contextSource: String(message.contextSource || ""),
      sources: Array.isArray(message.sources) ? message.sources.slice(0, CHAT_CONTEXT_LIMIT).map(normalizeSource).filter(Boolean) : [],
    };
  }

  function normalizeSource(source) {
    const title = String((source && source.title) || "").trim();
    if (!title) return null;
    return {
      title,
      tags: Array.isArray(source.tags) ? source.tags.map((tag) => String(tag)).filter(Boolean).slice(0, 4) : [],
      noteId: String(source.note_id || source.noteId || "").slice(0, 128),
      heading: String(source.heading || "").slice(0, 300),
      snippet: String(source.snippet || "").slice(0, 2000),
    };
  }

  function loadChats() {
    let session = {};
    try {
      const key = storageKey();
      if (boundProject.projectId && boundProject.legacyChatStorage
          && localStorage.getItem(key) === null && localStorage.getItem(`${key}:legacy-imported`) !== "1") {
        const legacy = localStorage.getItem(CHAT_STORAGE_KEY);
        if (legacy !== null) localStorage.setItem(key, legacy);
        localStorage.setItem(`${key}:legacy-imported`, "1");
      }
      const parsed = JSON.parse(localStorage.getItem(key) || "[]");
      chats = Array.isArray(parsed) ? parsed.slice(0, MAX_STORED_CHATS).map(normalizeChat).filter(Boolean) : [];
      try { session = JSON.parse(localStorage.getItem(`${key}:state`) || "{}"); }
      catch (_) { session = {}; }
    } catch (_) {
      chats = [];
      historyStorageFailed = true;
    }
    if (!chats.length) {
      chats = [createEmptyChat()];
    }
    for (const chat of chats) for (const message of chat.messages) {
      if (message.pending) interruptMessage(message);
    }
    selectedChatId = chats.some(chat => chat.id === session?.selectedChatId) ? session.selectedChatId : chats[0].id;
    chatInput.value = typeof session?.draft === "string" ? session.draft : "";
    chatSearch.value = typeof session?.search === "string" ? session.search : "";
    return Math.max(0, Number(session?.scrollTop) || 0);
  }

  function saveChats() {
    if (boundProject?.status !== "ready") return;
    try {
      const compact = chats
        .slice()
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, MAX_STORED_CHATS)
        .map((chat) => ({
          ...chat,
          messages: (chat.messages || []).slice(-MAX_STORED_MESSAGES),
        }));
      localStorage.setItem(storageKey(), JSON.stringify(compact));
      chats = compact;
      historyStorageFailed = false;
      if (!getSelectedChat() && chats.length) {
        selectedChatId = chats[0].id;
      }
      saveSession();
    } catch (_) {
      historyStorageFailed = true;
    }
  }

  function interruptMessage(message) {
    Object.assign(message, { pending: false, error: true, errorCode: "chat_interrupted" });
  }

  function renderStorageHint() {
    if (chatExportBtn) chatExportBtn.disabled = !scopeCurrent() || !chats.some(chat => chat.messages.length);
    if (!chatStorageHint) return;
    chatStorageHint.dataset.warning = String(historyStorageFailed);
    const text = historyStorageFailed
      ? t("Не удалось сохранить или прочитать историю. Экспортируйте доступные чаты перед закрытием приложения.",
        "Chat history could not be saved or read. Export the available chats before closing the app.")
      : t(`Хранятся до ${MAX_STORED_CHATS} чатов проекта и ${MAX_STORED_MESSAGES} сообщений в каждом. При заполнении удаляются самые старые записи.`,
        `Stores up to ${MAX_STORED_CHATS} chats per project and ${MAX_STORED_MESSAGES} messages per chat. The oldest entries are removed when full.`);
    if (chatStorageHint.textContent !== text) chatStorageHint.textContent = text;
  }

  function exportChats() {
    const conversations = chats.filter(chat => chat.messages.length);
    if (!scopeCurrent() || !conversations.length) return;
    const data = new Blob([JSON.stringify({ version: 1, exportedAt: nowIso(), chats: conversations }, null, 2)],
      { type: "application/json" });
    const url = URL.createObjectURL(data);
    const link = document.createElement("a");
    link.href = url;
    link.download = `noda-chats-${nowIso().slice(0, 10)}.json`;
    try { link.click(); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }

  function formatChatTime(value) {
    const date = new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    const now = new Date();
    const locale = window.nodaI18n?.locale() ?? "ru-RU";
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  function chatDisplayTitle(chat) {
    const automaticTitles = ["Новый чат", "New chat", ...Object.keys(window.nodaLanguages?.languages || {})
      .map(code => window.nodaLanguages.translate(code, "Новый чат", "New chat"))];
    if (chat?.title && (chat.messages.length || !automaticTitles.includes(chat.title))) {
      return chat.title;
    }
    return t("Новый чат", "New chat");
  }

  function messageDisplayText(message) {
    if (message.pending) {
      return t("Ищу ответ по заметкам...", "Looking for an answer in your notes...");
    }
    if (message.role === "assistant" && message.error) {
      return chatRequestErrorMessage(message.errorCode);
    }
    return message.text;
  }

  function getChatPreview(chat) {
    const lastMessage = [...(chat.messages || [])].reverse().find((message) => message.text);
    return lastMessage ? messageDisplayText(lastMessage).replace(/\s+/g, " ").slice(0, 86)
      : t("Спросите что-нибудь по заметкам...", "Ask a question about your notes...");
  }

  function deriveChatTitle(question) {
    const cleaned = String(question || "").replace(/\s+/g, " ").trim();
    if (!cleaned) {
      return t("Новый чат", "New chat");
    }
    return cleaned.length > 44 ? `${cleaned.slice(0, 44).trim()}...` : cleaned;
  }

  function buildRagHistory(messages) {
    return messages
      .filter((message) => !message.pending && !message.error && ["user", "assistant"].includes(message.role))
      .filter((message) => String(message.text || "").trim())
      .slice(-CHAT_HISTORY_CONTEXT_LIMIT)
      .map((message) => ({
        role: message.role,
        text: String(message.text || "").replace(/\s+/g, " ").trim().slice(0, 400),
      }));
  }

  function updateChatStatus() {
    const ready = scopeCurrent();
    if (chatSubtitle) chatSubtitle.hidden = false;
    if (chatNewBtn) chatNewBtn.disabled = !ready;
    if (!ready) {
      const message = boundProject?.status === "error"
        ? t("Проект недоступен. Выберите проект снова.", "The project is unavailable. Select it again.")
        : t("Переключение проекта…", "Switching project…");
      for (const element of [chatSubtitle]) {
        if (element) { element.textContent = message; element.classList.remove("active"); }
      }
      return;
    }
    const embedding = qdrantSnapshot.embedding_status;
    const setupSearch = document.getElementById("chat-semantic-setup");
    if (setupSearch) setupSearch.hidden = !semanticSearchBlocked();
    if (semanticSearchBlocked()) {
      const disabled = embedding === "disabled";
      if (chatSubtitle) chatSubtitle.textContent = disabled
        ? t("Чтобы включить чат, выберите «Настроить смысловой поиск» в меню значка Noda у часов Windows и перезапустите приложение.",
          "To enable chat, choose Set up semantic search from the Noda tray menu and restart the app.")
        : t("Не удалось загрузить модель смыслового поиска. Перезапустите Noda. В библиотеке доступен текстовый поиск.",
          "The semantic search model could not load. Restart Noda. Text search is available in the library.");
      return;
    }
    const qdrantReady = qdrantSnapshot.available === true;
    const qdrantOffline = qdrantSnapshot.available === false;
    if (chatSubtitle) {
      chatSubtitle.hidden = qdrantReady;
      chatSubtitle.textContent = qdrantReady ? ""
        : qdrantOffline ? t("Поиск недоступен", "Search unavailable")
          : t("Проверяем доступность поиска по заметкам…", "Checking whether note search is available…");
    }
  }

  function renderHistory() {
    // A hidden panel reports zero scroll offset; leave its history intact until activation.
    if (!chatHistoryList.getClientRects().length) return;
    const previousScrollTop = chatHistoryList.scrollTop;
    const focusedChatId = chatHistoryList.contains(document.activeElement)
      ? document.activeElement.dataset.chatId : null;
    const query = String(chatSearch ? chatSearch.value : "").trim().toLowerCase();
    const filtered = chats
      .slice()
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .filter(chat => !query || chatDisplayTitle(chat).toLowerCase().includes(query)
        || chat.messages.some(message => !message.pending && !message.error && message.text.toLowerCase().includes(query)));

    chatHistoryList.replaceChildren();
    chatCount.textContent = window.nodaI18n?.count(chats.length, ["чат", "чата", "чатов"], "chat", "chats")
      ?? `${chats.length} чатов`;
    if (!filtered.length) {
      const empty = document.createElement("li");
      empty.className = "chat-history-empty";
      empty.textContent = query ? t("В истории ничего не найдено.", "No matches in chat history.")
        : t("Чатов пока нет.", "No chats yet.");
      chatHistoryList.appendChild(empty);
      return;
    }
    filtered.forEach((chat) => chatHistoryList.appendChild(createHistoryItem(chat)));
    if (focusedChatId) {
      Array.from(chatHistoryList.querySelectorAll(".chat-history-item"))
        .find((item) => item.dataset.chatId === focusedChatId)?.focus({ preventScroll: true });
    }
    chatHistoryList.scrollTop = previousScrollTop;
  }

  function createHistoryItem(chat) {
    const epoch = chatEpoch;
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chat-history-item";
    button.dataset.chatId = chat.id;
    button.classList.toggle("active", chat.id === selectedChatId);
    button.addEventListener("click", () => {
      if (!scopeCurrent(epoch)) return;
      selectedChatId = chat.id;
      saveSession();
      chatHistoryList.querySelectorAll(".chat-history-item").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      renderMessages();
    });

    const title = document.createElement("span");
    title.className = "chat-history-title";
    title.textContent = chatDisplayTitle(chat);
    const preview = document.createElement("span");
    preview.className = "chat-history-preview";
    preview.textContent = getChatPreview(chat);
    const time = document.createElement("span");
    time.className = "chat-history-time";
    time.textContent = formatChatTime(chat.updatedAt);

    button.append(title, preview, time);
    li.appendChild(button);
    return li;
  }

  function clearPendingViews() {
    for (const view of pendingViews) view.destroy();
    pendingViews = [];
  }

  function renderMessages() {
    const chat = getSelectedChat();
    clearPendingViews();
    chatMessages.replaceChildren();
    if (!chat || !chat.messages.length) {
      const empty = document.createElement("div");
      empty.className = "chat-empty-state";
      empty.textContent = semanticSearchBlocked()
        ? t("Искать по тексту можно на вкладке «Заметки».", "You can search by text on the Notes tab.")
        : qdrantSnapshot.available === true && !notesSnapshot.length
        ? t("В этом проекте пока нет заметок. Добавьте заметку, чтобы начать поиск.",
          "There are no notes in this project yet. Add a note to start searching.")
        : t("Задайте вопрос по вашим заметкам. Ответ будет построен только по найденному контексту.",
          "Ask a question about your notes. The answer will use only the context found in them.");
      chatMessages.appendChild(empty);
      updateConversationHeader(chat);
      return;
    }
    chat.messages.forEach((message) => chatMessages.appendChild(createMessageNode(message, message === chat.messages.at(-1))));
    chatMessages.scrollTop = chatMessages.scrollHeight;
    updateConversationHeader(chat);
  }

  function updateConversationHeader(chat) {
    if (chatTitle) chatTitle.textContent = chatDisplayTitle(chat);
    chatMenuBtn.disabled = !scopeCurrent() || !chat?.messages.length || chat.messages.some(message => message.pending);
    updateChatStatus();
  }

  function createMessageNode(message, isLast) {
    const row = document.createElement("article");
    row.className = `chat-message-row ${message.role}`;
    const bubble = document.createElement("div");
    bubble.className = "chat-message-bubble";
    bubble.classList.toggle("pending", Boolean(message.pending));
    bubble.classList.toggle("error", Boolean(message.error) && message.errorCode !== "chat_stopped");

    const meta = document.createElement("div");
    meta.className = "chat-message-meta";
    meta.textContent = formatChatTime(message.createdAt);

    bubble.append(meta);
    if (message.role === "assistant" && message.pending && window.NodaChatSearch) {
      const view = window.NodaChatSearch.create(messageDisplayText(message));
      pendingViews.push(view);
      bubble.appendChild(view.element);
    } else {
      const text = document.createElement("div");
      text.className = "chat-message-text";
      const content = messageDisplayText(message);
      const formatted = message.role === "assistant" && !message.error && !message.pending
        ? window.notesMarkdown?.renderChat(content) : null;
      if (formatted) {
        text.classList.add("markdown-preview", "chat-message-markdown");
        text.appendChild(formatted);
      } else {
        text.textContent = content;
      }
      bubble.appendChild(text);
    }
    if (message.role === "assistant" && message.sources && message.sources.length) {
      bubble.appendChild(createSourcesRow(message.sources, message.contextSource));
    }
    if (message.role === "assistant" && message.error && isLast && message.errorCode !== "query_too_long") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "secondary-btn chat-retry-btn";
      retry.disabled = sending || semanticSearchBlocked();
      retry.textContent = t("Повторить запрос", "Retry question");
      retry.addEventListener("click", retryQuestion);
      bubble.appendChild(retry);
    }
    if (message.role === "assistant") {
      const avatar = document.createElement("div");
      avatar.className = "chat-message-avatar";
      avatar.setAttribute("aria-hidden", "true");
      const icon = document.createElement("img");
      icon.src = "assets/noda-bot-signal.svg";
      icon.alt = "";
      icon.width = 24;
      icon.height = 24;
      avatar.append(icon);
      row.append(avatar, bubble);
    } else {
      row.append(meta, bubble);
    }
    return row;
  }

  function formatSourceCount(count) {
    const forms = ["источник", "источника", "источников"];
    const fallback = count === 1 ? forms[0] : count >= 2 && count <= 4 ? forms[1] : forms[2];
    return window.nodaI18n?.count(count, forms, "source", "sources") ?? `${count} ${fallback}`;
  }

  function createSourcesRow(sources, contextSource) {
    const row = document.createElement("div");
    row.className = "chat-source-row";
    sources.forEach((source) => {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "chat-source-pill";
      pill.dataset.noteTitle = source.title;
      pill.dataset.noteId = source.noteId;
      pill.dataset.projectEpoch = String(chatEpoch);
      pill.dataset.projectId = boundProject?.projectId || "";
      pill.textContent = source.title;
      pill.title = source.title;
      row.appendChild(pill);
    });
    const count = document.createElement("span");
    count.className = "chat-source-count";
    const origin = contextSource === "cache" ? t("кэш", "cache")
      : contextSource === "unavailable" ? t("недоступен", "unavailable") : "";
    count.textContent = `${formatSourceCount(sources.length)}${origin ? ` • ${origin}` : ""}`;
    row.appendChild(count);
    if (!sources.some(source => source.snippet)) return row;
    const wrapper = document.createElement("div");
    wrapper.appendChild(row);
    const details = document.createElement("details");
    details.className = "chat-citation";
    const label = document.createElement("summary");
    label.textContent = t("Показать цитаты из заметок", "Show excerpts from notes");
    details.appendChild(label);
    for (const source of sources.filter(item => item.snippet)) {
      const quote = document.createElement("blockquote");
      quote.textContent = `${source.title}${source.heading ? ` · ${source.heading}` : ""}\n${source.snippet}`;
      details.appendChild(quote);
    }
    wrapper.appendChild(details);
    return wrapper;
  }

  function renderAll() {
    renderHistory();
    renderMessages();
    renderStorageHint();
  }

  function startNewChat() {
    if (!scopeCurrent()) return;
    if (!getSelectedChat()?.messages.length) { chatInput.focus(); return; }
    const chat = createEmptyChat();
    chats.unshift(chat);
    selectedChatId = chat.id;
    chatSearch.value = "";
    saveChats();
    renderAll();
    chatHistoryList.scrollTop = 0;
    chatInput.focus();
  }

  async function sendQuestion(question, chat, retryMessage) {
    const epoch = chatEpoch;
    const conversationHistory = buildRagHistory(retryMessage ? chat.messages.slice(0, -2) : chat.messages);
    const timestamp = nowIso();
    if (!chat.messages.length || !chat.title) chat.title = deriveChatTitle(question);
    chat.updatedAt = timestamp;
    const assistantMessage = retryMessage || { id: createId("msg"), role: "assistant" };
    Object.assign(assistantMessage, { text: "", createdAt: timestamp, pending: true, error: false, errorCode: "", sources: [] });
    if (!retryMessage) chat.messages.push({ id: createId("msg"), role: "user", text: question, createdAt: timestamp }, assistantMessage);
    saveChats();
    const focusBeforeRequest = document.activeElement;
    setSending(true);
    renderAll();
    const focusMovedToStop = [chatInput, chatSendBtn].includes(focusBeforeRequest)
      || focusBeforeRequest?.classList.contains("chat-retry-btn");
    if (focusMovedToStop && chatStopBtn?.getClientRects().length) chatStopBtn.focus();

    try {
      const payload = await ragRequest(question, conversationHistory, epoch);
      if (!scopeCurrent(epoch)) return;
      assistantMessage.text = String(payload.response || t("По заметкам не удалось сформировать ответ.",
        "Could not find an answer in the notes."));
      assistantMessage.pending = false;
      assistantMessage.contextSource = String(payload.context_source || "");
      assistantMessage.sources = Array.isArray(payload.context)
        ? payload.context.slice(0, CHAT_CONTEXT_LIMIT).map(normalizeSource).filter(Boolean) : [];
      if (assistantMessage.contextSource === "qdrant") {
        qdrantSnapshot.available = true;
        if (qdrantSnapshot.embedding_status === "unavailable") qdrantSnapshot.embedding_status = "ready";
      }
    } catch (error) {
      if (!scopeCurrent(epoch)) return;
      assistantMessage.errorCode = typeof error?.code === "string" ? error.code.slice(0, 40) : "";
      assistantMessage.text = chatRequestErrorMessage(assistantMessage.errorCode);
      assistantMessage.pending = false;
      assistantMessage.error = true;
      if (assistantMessage.errorCode === "qdrant_unavailable") qdrantSnapshot.available = false;
    } finally {
      if (scopeCurrent(epoch)) {
        const updatedChat = chats.find(item => item.id === chat.id);
        if (updatedChat) updatedChat.updatedAt = nowIso();
        saveChats();
        const restoreFocus = [focusBeforeRequest, chatStopBtn].includes(document.activeElement);
        setSending(false);
        renderAll();
        if (restoreFocus && chatInput.getClientRects().length) chatInput.focus();
      }
    }
  }

  function retryQuestion() {
    const chat = getSelectedChat();
    const message = chat?.messages.at(-1), question = chat?.messages.at(-2);
    if (!scopeCurrent() || semanticSearchBlocked() || sending || !message?.error || question?.role !== "user") return;
    if (queryLength(question.text) > CHAT_QUERY_MAX_CHARS) {
      chatInput.value = question.text;
      updateQueryHint();
      chatInput.focus();
      return;
    }
    return sendQuestion(question.text, chat, message);
  }

  async function ragRequest(query, history, epoch) {
    const captured = boundProject;
    const controller = new AbortController();
    activeRequest = controller;
    const timeout = Object.assign(new Error("Chat request timed out"), { code: "chat_timeout" });
    let preparingRuntime = typeof window.quickNoteBridge?.ensureChatRuntimeReady === "function";
    let timer = setTimeout(() => controller.abort(timeout), preparingRuntime ? CHAT_READY_TIMEOUT_MS : RAG_REQUEST_TIMEOUT_MS);
    try {
      if (preparingRuntime) {
        const ready = await awaitAbortable(window.quickNoteBridge.ensureChatRuntimeReady(captured.projectId
          ? { projectId: captured.projectId, contextToken: captured.contextToken } : undefined), controller.signal);
        if (ready?.ok !== true) throw new Error(t("Модель чата пока недоступна.", "The chat model is unavailable."));
        preparingRuntime = false;
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(timeout), RAG_REQUEST_TIMEOUT_MS);
      }
      if (!scopeCurrent(epoch) || controller.signal.aborted) throw new Error("Chat request cancelled");
      const request = projectContext ? projectContext.fetch : fetch;
      const response = await awaitAbortable(request(`${API_BASE}/rag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit: CHAT_CONTEXT_LIMIT, history: Array.isArray(history) ? history : [] }),
        signal: controller.signal,
      }), controller.signal);
      const payload = await awaitAbortable(response.json().catch(() => null), controller.signal);
      if (!scopeCurrent(epoch) || controller.signal.aborted) throw new Error("Chat request cancelled");
      if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}`), { code: payload?.code });
      }
      if (typeof payload?.response !== "string" || !payload.response.trim()) {
        throw Object.assign(new Error("Invalid chat response"), { code: "rag_generation_failed" });
      }
      return payload;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (preparingRuntime) throw Object.assign(new Error("Chat preparation failed"), { code: "chat_model_unavailable" });
      throw error;
    } finally {
      clearTimeout(timer);
      if (activeRequest === controller) activeRequest = null;
    }
  }

  function chatRequestErrorMessage(code) {
    switch (code) {
      case "chat_model_loading":
        return t("Модель чата ещё загружается. Попробуйте чуть позже.", "The chat model is still loading. Try again shortly.");
      case "chat_model_unavailable":
        return t("Модель чата недоступна. Проверьте выбранную модель в настройках.", "The chat model is unavailable. Check the selected model in Settings.");
      case "qdrant_unavailable":
        return t("Поиск по заметкам временно недоступен. Повторите попытку.", "Note search is temporarily unavailable. Try again.");
      case "chat_timeout":
        return t("Ответ занял слишком много времени. Попробуйте уточнить вопрос.", "The answer took too long. Try a more specific question.");
      case "chat_stopped":
        return t("Ожидание ответа остановлено. Модель может закончить текущую операцию в фоне.",
          "Stopped waiting for the answer. The model may finish its current operation in the background.");
      case "chat_interrupted":
        return t("Запрос прерван. Его можно повторить.", "The request was interrupted. You can retry it.");
      case "query_too_long":
        return t(`Сократите вопрос до ${CHAT_QUERY_MAX_CHARS} символов и отправьте снова.`,
          `Shorten the question to ${CHAT_QUERY_MAX_CHARS} characters and send it again.`);
      case "rag_generation_failed":
        return t("Модель не смогла сформировать ответ с источниками. Повторите попытку.", "The model could not produce an answer with sources. Try again.");
      default:
        return t("Не удалось получить ответ. Повторите попытку.", "Could not get an answer. Please try again.");
    }
  }

  function awaitAbortable(promise, signal) {
    return new Promise((resolve, reject) => {
      const cancel = () => reject(signal.reason);
      if (signal.aborted) { cancel(); return; }
      signal.addEventListener("abort", cancel, { once: true });
      Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    });
  }

  function queryLength(text) {
    return Array.from(text.trim()).length;
  }

  function updateQueryHint() {
    const invalid = queryLength(chatInput.value) > CHAT_QUERY_MAX_CHARS;
    chatInput.setAttribute("aria-invalid", String(invalid));
    if (chatQueryHint) {
      chatQueryHint.dataset.invalid = String(invalid);
      const text = invalid ? chatRequestErrorMessage("query_too_long")
        : t(`До ${CHAT_QUERY_MAX_CHARS} символов.`, `Up to ${CHAT_QUERY_MAX_CHARS} characters.`);
      if (chatQueryHint.textContent !== text) chatQueryHint.textContent = text;
    }
    return !invalid;
  }

  function semanticSearchBlocked() { return ["disabled", "unavailable"].includes(qdrantSnapshot.embedding_status); }

  function setSending(nextSending) {
    sending = Boolean(nextSending);
    const locked = sending || !scopeCurrent() || semanticSearchBlocked();
    if (chatInput) chatInput.disabled = locked;
    if (chatSendBtn) {
      chatSendBtn.disabled = locked;
      chatSendBtn.hidden = sending;
    }
    if (chatStopBtn) chatStopBtn.hidden = !sending;
    chatMessages.querySelectorAll(".chat-retry-btn").forEach(button => { button.disabled = locked; });
  }

  function switchChatProject(next) {
    if (boundProject?.epoch === next.epoch && boundProject.status === next.status
        && boundProject.projectId === next.projectId && boundProject.contextToken === next.contextToken) {
      boundProject = next;
      updateChatStatus();
      return;
    }
    if (boundProject?.status === "ready") {
      for (const chat of chats) for (const message of chat.messages) {
        if (message.pending) interruptMessage(message);
      }
      saveChats();
      saveSession();
    }
    activeRequest?.abort();
    activeRequest = null;
    chatEpoch += 1;
    boundProject = next;
    chats = []; selectedChatId = ""; notesSnapshot = []; qdrantSnapshot = {};
    historyStorageFailed = false;
    chatInput.value = ""; chatSearch.value = ""; chatHistoryList.scrollTop = 0;
    const restoredScroll = next.status === "ready" ? loadChats() : 0;
    setSending(false);
    updateQueryHint();
    chatSearch.disabled = next.status !== "ready";
    renderAll();
    chatHistoryList.scrollTop = restoredScroll;
  }

  function bindEvents() {
    chatNewBtn?.addEventListener("click", startNewChat);
    chatExportBtn?.addEventListener("click", exportChats);
    chatStopBtn?.addEventListener("click", () => {
      if (scopeCurrent()) activeRequest?.abort(Object.assign(new Error("Stopped waiting"), { code: "chat_stopped" }));
    });
    chatSearch.addEventListener("input", () => {
      if (!scopeCurrent()) return;
      chatHistoryList.scrollTop = 0;
      saveSession();
      renderHistory();
    });
    chatInput.addEventListener("input", () => { updateQueryHint(); saveSession(); });
    chatHistoryList.addEventListener("scroll", saveSession, { passive: true });
    chatForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const question = chatInput.value.trim(), chat = getSelectedChat();
      if (!question || !chat || sending || !scopeCurrent() || semanticSearchBlocked()) return;
      if (!updateQueryHint()) { chatInput.focus(); return; }
      chatInput.value = "";
      updateQueryHint();
      return sendQuestion(question, chat);
    });
    chatMenuBtn.addEventListener("click", () => {
      if (!scopeCurrent()) return;
      const chat = getSelectedChat();
      if (!chat || !chat.messages.length || chat.messages.some(message => message.pending)) {
        return;
      }
      if (window.confirm(t(`Удалить чат "${chat.title}"?`, `Delete the chat "${chat.title}"?`))) {
        chats = chats.filter((item) => item.id !== chat.id);
        if (!chats.length) {
          chats = [createEmptyChat()];
        }
        selectedChatId = chats[0].id;
        saveChats();
        renderAll();
      }
    });
    chatMessages.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      const source = event.target.closest("[data-note-title]");
      if (!source || !scopeCurrent() || source.dataset.projectEpoch !== String(chatEpoch)
          || source.dataset.projectId !== (boundProject.projectId || "")) {
        return;
      }
      const noteId = source.dataset.noteId;
      const match = noteId ? notesSnapshot.find(note => String(note.qdrant_id || "") === noteId) : null;
      if (noteId && !match && notesSnapshot.some(note => note.qdrant_id)) {
        const warning = document.createElement("span");
        warning.setAttribute("role", "status");
        warning.textContent = t("Источник больше не найден в проекте.", "The source note is no longer found in this project.");
        source.disabled = true;
        source.parentElement.appendChild(warning);
        return;
      }
      window.dispatchEvent(new CustomEvent("notes-chat:open-note", {
        detail: { title: match?.title || source.dataset.noteTitle, projectContext: boundProject },
      }));
    });
  }

  function init() {
    if (!chatHistoryList || !chatMessages || !chatForm) return;
    bindEvents();
    if (projectContext) {
      projectContext.subscribe(switchChatProject);
      projectContext.ready().catch(() => {});
    } else {
      switchChatProject({ projectId: null, contextToken: null, epoch: 0, legacyChatStorage: true,
        status: window.quickNoteBridge ? "error" : "ready" });
    }
    window.addEventListener("beforeunload", () => { saveSession(); activeRequest?.abort(); clearPendingViews(); }, { once: true });
  }

  window.notesChatController = {
    activate() {
      renderAll();
      if (chatInput && scopeCurrent()) chatInput.focus();
    },
    setNotesState(payload) {
      if (!scopeCurrent()) return;
      notesSnapshot = Array.isArray(payload && payload.notes) ? payload.notes : [];
      qdrantSnapshot = { ...payload?.qdrant };
      setSending(sending);
      if (!getSelectedChat()?.messages.length) renderMessages();
      else updateChatStatus();
    },
    startNewChat,
  };

  init();
})();
