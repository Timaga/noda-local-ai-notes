"use strict";

const QUICK_CAPTURE_WINDOW = Object.freeze({
  width: 800, height: 86, minWidth: 320, minHeight: 86,
  maxHeight: 650, bottomOffset: 28,
});

function captureBounds(workArea, requestedHeight) {
  const width = Math.min(QUICK_CAPTURE_WINDOW.width, workArea.width);
  const height = Math.min(Math.max(QUICK_CAPTURE_WINDOW.minHeight, requestedHeight),
    QUICK_CAPTURE_WINDOW.maxHeight, workArea.height);
  return {
    x: workArea.x + Math.max(0, Math.round((workArea.width - width) / 2)),
    y: workArea.y + Math.max(0, workArea.height - height - QUICK_CAPTURE_WINDOW.bottomOffset),
    width, height,
  };
}

function createQuickCaptureController({ getWindow, screen }) {
  let requestedHeight = QUICK_CAPTURE_WINDOW.height;

  function sendInputFocus(win) {
    win.webContents.focus();
    win.webContents.send("quick-note:focus-input");
  }

  function place(win, useCursor) {
    const display = useCursor
      ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      : screen.getDisplayMatching(win.getBounds());
    win.setBounds(captureBounds(display.workArea, requestedHeight), false);
  }

  return {
    show(win) {
      place(win, true);
      win.show();
      win.focus();
      sendInputFocus(win);
    },
    focusInput(win) {
      if (!win || win.isDestroyed() || !win.isVisible() || !win.isFocused()) return false;
      sendInputFocus(win);
      return true;
    },
    flushDraftStorage() {
      const win = getWindow();
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.session.flushStorageData();
      }
    },
    resize(event, height) {
      const win = getWindow();
      if (!win || win.isDestroyed() || event?.sender !== win.webContents) {
        return { ok: false, error: "forbidden" };
      }
      if (!Number.isInteger(height) || height < 1 || height > 4096) {
        return { ok: false, error: "invalid_height" };
      }
      requestedHeight = height;
      place(win, false);
      return { ok: true };
    },
  };
}

module.exports = { QUICK_CAPTURE_WINDOW, captureBounds, createQuickCaptureController };
