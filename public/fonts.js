/* Loads the web fonts without making the page wait for them. A normal <link> holds
   back the page's scripts until the font file arrives, so on weak signal the sign-in
   button did nothing useful. Text shows in a system font until the web font is ready. */
"use strict";
(() => {
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = document.currentScript.dataset.href;
  document.head.append(l);
})();
