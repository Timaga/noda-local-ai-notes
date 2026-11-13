(() => {
  "use strict";

  const star = "0,-5 1.18,-1.62 4.76,-1.55 1.9,.62 2.94,4.05 0,2 -2.94,4.05 -1.9,.62 -4.76,-1.55 -1.18,-1.62";
  const chineseStars = [[5, 5, .66, 0], [10, 2, .22, -30], [12, 4, .22, -55], [12, 7, .22, -70], [10, 9, .22, -5]]
    .map(([x, y, scale, angle]) => `<polygon points="${star}" transform="translate(${x} ${y}) rotate(${angle}) scale(${scale})"/>`).join("");
  const koreanBars = [
    [4.6, 4.1, -56, [false, false, false]], [19.4, 4.1, 56, [true, false, true]],
    [4.6, 11.9, 56, [false, true, false]], [19.4, 11.9, -56, [true, true, true]],
  ].map(([x, y, angle, broken]) => `<g transform="translate(${x} ${y}) rotate(${angle})">${broken.map((split, index) => {
    const row = (index - 1) * 1.05;
    return split ? `M-1.85 ${row}h1.5m.7 0h1.5` : `M-1.85 ${row}h3.7`;
  }).map(path => `<path d="${path}"/>`).join("")}</g>`).join("");

  const drawings = {
    es: '<path fill="#aa151b" d="M0 0h24v16H0z"/><path fill="#f1bf00" d="M0 4h24v8H0z"/><path fill="#aa151b" d="M6 6h3v3a1.5 1.5 0 0 1-3 0z"/><path stroke="#fff2ba" stroke-width=".6" d="M6.5 7h2m-1 0v2"/>',
    fr: '<path fill="#fff" d="M0 0h24v16H0z"/><path fill="#002395" d="M0 0h8v16H0z"/><path fill="#ed2939" d="M16 0h8v16h-8z"/>',
    de: '<path fill="#000" d="M0 0h24v16H0z"/><path fill="#d00" d="M0 5.33h24v10.67H0z"/><path fill="#ffce00" d="M0 10.67h24V16H0z"/>',
    pt: '<path fill="#009c3b" d="M0 0h24v16H0z"/><path fill="#ffdf00" d="m12 1.6 10 6.4-10 6.4L2 8z"/><circle cx="12" cy="8" r="3.65" fill="#002776"/><path fill="none" stroke="#fff" stroke-width=".85" d="M8.6 7.2q3.4-.45 6.8 2.2"/>',
    it: '<path fill="#fff" d="M0 0h24v16H0z"/><path fill="#009246" d="M0 0h8v16H0z"/><path fill="#ce2b37" d="M16 0h8v16h-8z"/>',
    zh: `<path fill="#de2910" d="M0 0h24v16H0z"/><g fill="#ffde00">${chineseStars}</g>`,
    ja: '<path fill="#fff" d="M0 0h24v16H0z"/><circle cx="12" cy="8" r="4.6" fill="#bc002d"/>',
    ko: `<path fill="#fff" d="M0 0h24v16H0z"/><g transform="rotate(33.7 12 8)"><circle cx="12" cy="8" r="3.65" fill="#0047a0"/><path fill="#cd2e3a" d="M8.35 8a3.65 3.65 0 0 1 7.3 0 1.825 1.825 0 0 1-3.65 0 1.825 1.825 0 0 0-3.65 0z"/></g><g fill="none" stroke="#000" stroke-width=".7">${koreanBars}</g>`,
  };
  window.nodaLanguageFlags = Object.freeze(Object.fromEntries(Object.entries(drawings).map(([code, drawing]) => [
    code, "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16">${drawing}</svg>`),
  ])));
})();
