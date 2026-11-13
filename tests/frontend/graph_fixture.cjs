"use strict";
const { initial } = require("./projects_fixture.cjs");
function graphInitial(language) {
  const data = initial(language);
  const titles = language === "en" ? ["CRM roadmap", "Team calendar", "Calendar integrations", "Shared events", "New workspace", "Access roles", "Notifications", "Weekly planning", "Customer requests", "Ticket statuses", "Support chat", "Contact history", "Service metrics", "API gateway", "Release checklist", "User onboarding", "Feature feedback", "Product analytics", "Mobile client", "Offline sync", "Design system", "Dark theme", "Search index", "Import notes", "Knowledge base", "Backups", "Architecture", "Deployment", "Personal ideas", "Reading list"]
    : ["План развития CRM", "Календарь команды", "Интеграции календаря", "Общие события", "Новое рабочее пространство", "Роли и права", "Уведомления", "Планирование недели", "Обращения клиентов", "Статусы тикетов", "Чат поддержки", "История контактов", "Метрики сервиса", "Шлюз API", "Проверка перед релизом", "Онбординг пользователей", "Обратная связь", "Продуктовая аналитика", "Мобильный клиент", "Офлайн синхронизация", "Дизайн система", "Тёмная тема", "Поисковый индекс", "Импорт заметок", "База знаний", "Резервные копии", "Архитектура", "Развёртывание", "Личные идеи", "Список для чтения"];
  const pairs = [];
  for (let i = 1; i < 28; i++) {
    pairs.push([Math.floor((i - 1) / 4) * 4, i]);
    if (i % 4 > 1) pairs.push([i - 1, i]);
  }
  for (const [id, project] of Object.entries(data.data)) {
    const names = id === data.A ? titles : [language === "en" ? "Boreal plan" : "План Boreal", language === "en" ? "Boreal release" : "Релиз Boreal"];
    project.graph = { nodes: names.map((title, i) => ({ id: `graph-${i}`, title })), edges: (id === data.A ? pairs : [[0, 1]]).map(([a, b]) => ({ source: `graph-${a}`, target: `graph-${b}` })),
      unresolved: id === data.A ? 2 : 0 };
    project.notes = project.graph.nodes.map(node => ({ title: node.id, display_title: node.title, snippet: `${project.marker}: ${node.title}`, tags: [], indexed: true, content_revision: project.revision }));
    project.details = Object.fromEntries(project.graph.nodes.map(node => [node.id, { title: node.id, display_title: node.title, content: `${project.marker}: ${node.title}. ${language === "en" ? "Synthetic project note for interface verification." : "Синтетическая заметка проекта для проверки интерфейса."}`, tags: [], content_revision: project.revision }]));
  }
  return data;
}
function setupGraphHttp() {
  const base = window.fetch;
  window.__graph = { fail: false, hold: false, pending: [], calls: [] };
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, location.href);
    if (parsed.pathname !== "/notes-graph") return base(url, options);
    const state = window.__projects, control = window.__graph, headers = new Headers(options.headers), id = headers.get("X-Noda-Project-Id");
    control.calls.push({ id, url: parsed.href });
    if (id !== state.context.activeProjectId || headers.get("X-Noda-Project-Context") !== state.context.context.context_token || state.context.status !== "ready") { state.violations.push("graph context"); throw new Error("Graph context violation"); }
    const p = state.data[id], payload = control.fail ? { error: "Synthetic failure" } : parsed.searchParams.get("if_revision") === p.revision
      ? { unchanged: true, vault_id: p.vault, revision: p.revision } : { ...p.graph, vault_id: p.vault, revision: p.revision };
    const result = new Response(JSON.stringify(payload), { status: control.fail ? 503 : 200, headers: { "Content-Type": "application/json" } });
    if (control.hold) return new Promise(resolve => control.pending.push(() => resolve(result)));
    return result;
  };
}
module.exports = { graphInitial, setupGraphHttp };
