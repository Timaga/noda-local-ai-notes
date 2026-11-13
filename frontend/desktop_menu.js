const { translate } = require("./ui_languages");

const roleLabels = {
  filemenu: ["Файл", "File"],
  editmenu: ["Правка", "Edit"],
  viewmenu: ["Вид", "View"],
  windowmenu: ["Окно", "Window"],
  quit: ["Выход", "Exit"],
  undo: ["Отменить", "Undo"],
  redo: ["Повторить", "Redo"],
  cut: ["Вырезать", "Cut"],
  copy: ["Копировать", "Copy"],
  paste: ["Вставить", "Paste"],
  delete: ["Удалить", "Delete"],
  selectall: ["Выделить всё", "Select All"],
  reload: ["Перезагрузить", "Reload"],
  forcereload: ["Перезагрузить без кеша", "Force Reload"],
  toggledevtools: ["Инструменты разработчика", "Toggle Developer Tools"],
  resetzoom: ["Исходный масштаб", "Actual Size"],
  zoomin: ["Увеличить масштаб", "Zoom In"],
  zoomout: ["Уменьшить масштаб", "Zoom Out"],
  togglefullscreen: ["Полноэкранный режим", "Toggle Full Screen"],
  minimize: ["Свернуть", "Minimize"],
  zoom: ["Развернуть", "Zoom"],
  close: ["Закрыть", "Close"],
};

function localizeDesktopMenu(menu, language) {
  for (const item of menu?.items ?? []) {
    const labels = roleLabels[item.role];
    if (Array.isArray(labels)) item.label = translate(language, ...labels);
    if (item.submenu) localizeDesktopMenu(item.submenu, language);
  }
}

module.exports = { localizeDesktopMenu };
