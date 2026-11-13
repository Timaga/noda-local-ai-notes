"use strict";

(function () {
  const VIDEO = "assets/noda-search-loop.mp4";
  const POSTER = "assets/noda-search-poster.png";

  function create(label) {
    const element = document.createElement("div");
    element.className = "chat-search-status";
    const media = document.createElement("div");
    media.className = "chat-search-media";
    media.setAttribute("aria-hidden", "true");

    const poster = document.createElement("img");
    poster.className = "chat-search-poster";
    poster.src = POSTER;
    poster.alt = "";
    poster.width = 960;
    poster.height = 540;

    const video = document.createElement("video");
    video.className = "chat-search-video";
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.poster = POSTER;
    video.tabIndex = -1;
    video.setAttribute("disablepictureinpicture", "");
    const caption = document.createElement("p");
    caption.className = "chat-search-caption";
    caption.textContent = label;
    media.append(poster, video);
    element.append(media, caption);

    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let destroyed = false;
    let failed = false;
    let onScreen = true;
    function updatePlayback() {
      if (destroyed) return;
      const still = failed || Boolean(motion?.matches);
      video.hidden = still;
      poster.hidden = !still;
      if (still || document.hidden || !onScreen) {
        video.pause();
        return;
      }
      if (!video.getAttribute("src")) video.src = VIDEO;
      const playing = video.play();
      if (playing?.catch) playing.catch(() => {
        if (destroyed || document.hidden || !onScreen || motion?.matches) return;
        failed = true;
        updatePlayback();
      });
    }
    function failPlayback() {
      failed = true;
      updatePlayback();
    }
    video.addEventListener("error", failPlayback);
    document.addEventListener("visibilitychange", updatePlayback);
    motion?.addEventListener("change", updatePlayback);
    const observer = typeof window.IntersectionObserver === "function"
      ? new window.IntersectionObserver(entries => {
        onScreen = entries.some(entry => entry.isIntersecting);
        updatePlayback();
      }) : null;
    observer?.observe(element);
    updatePlayback();

    return { element, destroy() {
      if (destroyed) return;
      destroyed = true;
      observer?.disconnect();
      motion?.removeEventListener("change", updatePlayback);
      document.removeEventListener("visibilitychange", updatePlayback);
      video.removeEventListener("error", failPlayback);
      video.pause();
      video.removeAttribute("src");
      video.load();
    } };
  }

  window.NodaChatSearch = Object.freeze({ create });
})();
