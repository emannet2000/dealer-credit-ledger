/* Puts the app on the phone. Used by the staff app and the dealer portal.
   Chrome and Edge offer an install prompt the app can trigger; iPhones and some other
   browsers don't, so those get the steps instead. PWA.html() shows whichever applies. */
"use strict";
(() => {
  let offer = null;
  const installed = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const iOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const note = (t) => `<p class="small muted" style="margin:8px 0 0">${t}</p>`;
  const inner = () => {
    if (installed()) return "";
    if (!window.isSecureContext) return note("Installing needs the site on HTTPS.");
    if (offer) return `<button class="btn sm primary" data-install type="button">Install app</button>` + note("Adds Ledger to this device, with its own icon.");
    if (iOS()) return note("To install, tap Share, then Add to Home Screen.");
    return note("To install, open the browser menu and choose Install app or Add to Home screen.");
  };
  const repaint = () => document.querySelectorAll("[data-install-slot]").forEach((el) => { el.innerHTML = inner(); });

  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); offer = e; repaint(); });
  addEventListener("appinstalled", () => { offer = null; repaint(); });
  document.addEventListener("click", async (e) => {
    if (!offer || !e.target.closest("[data-install]")) return;
    const asked = offer;
    offer = null; // The browser allows each prompt to be used once.
    await asked.prompt();
    await asked.userChoice;
    repaint();
  });
  if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});

  window.PWA = Object.freeze({ html: () => `<div data-install-slot>${inner()}</div>` });
})();
