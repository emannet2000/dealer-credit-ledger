/* Connects the ledger page to the Node.js server.
   It provides the same small data interface the page was written against
   (collections, documents, live snapshots, users, photos, downloads). */
(() => {
  "use strict";
  const OFFLINE = { code: "offline", message: "You're offline.", userMsg: "You're offline. Only new payments, sales and returns can be recorded without a connection; they sync when you're back online." };
  async function api(method, url, body, headers = {}) {
    const isBlob = typeof Blob !== "undefined" && body instanceof Blob;
    let r;
    try {
      r = await fetch(url, {
        method, credentials: "same-origin",
        headers: { ...(body !== undefined && !isBlob ? { "Content-Type": "application/json" } : {}), ...headers },
        body: body === undefined ? undefined : isBlob ? body : JSON.stringify(body),
      });
    } catch (e) { setOnline(false); throw { ...OFFLINE }; }
    setOnline(true);
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) {
      // Signed out remotely (lost phone): wipe the offline copy before leaving.
      if (data.code === "revoked") { try { await kv.clear(); (await navigator.serviceWorker?.getRegistration())?.active?.postMessage("clear"); } catch (e) {} location.href = "/login?wiped=1"; }
      else location.href = "/login";
      throw { code: "unauthenticated", message: "Signed out" };
    }
    if (!r.ok) throw { code: data.code || (r.status === 413 ? "too_large" : "unavailable"), message: data.message || "Request failed", userMsg: data.message, status: r.status };
    return data;
  }

  /* ---------- offline support (FR-086) ----------
     The collector's data (dealers, transactions, store settings, own account) is kept
     in IndexedDB so the app opens without signal. New payments recorded offline are
     queued with a unique key and synced later; the server ignores a key it has seen.
     Payments the server refuses are held for review. Everything is wiped on sign-out. */
  const OFFLINE_COLS = new Set(["dealers", "txns", "settings"]);
  const kv = (() => {
    let dbp = null;
    const open = () => (dbp = dbp || new Promise((res, rej) => {
      const r = indexedDB.open("dcl-offline", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const run = (mode, fn) => open().then((d) => new Promise((res, rej) => {
      const t = d.transaction("kv", mode); const req = fn(t.objectStore("kv"));
      t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error);
    }));
    return {
      get: (k) => run("readonly", (st) => st.get(k)).catch(() => undefined),
      set: (k, v) => run("readwrite", (st) => st.put(v, k)).catch(() => {}),
      clear: () => run("readwrite", (st) => st.clear()).catch(() => {}),
    };
  })();
  const off = { online: navigator.onLine !== false, queue: [], held: [], lastSync: null, ready: null, syncing: false };
  function announce() { try { window.dispatchEvent(new CustomEvent("dcl-offline")); } catch (e) {} }
  function setOnline(v) { if (off.online !== v) { off.online = v; announce(); if (v) setTimeout(flush, 0); } }
  // Keep only what a collector needs on the device.
  const lean = (c, data) => {
    if (c !== "dealers") return data;
    const { firstName, middleName, lastName, age, gender, birthday, email, messenger, address, stageHistory, limitHistory, ...rest } = data;
    return rest;
  };
  const saveQueue = () => Promise.all([kv.set("queue", off.queue), kv.set("held", off.held)]);
  off.ready = (async () => {
    off.queue = (await kv.get("queue")) || []; off.held = (await kv.get("held")) || []; off.lastSync = (await kv.get("lastSync")) || null;
  })();
  function mergePending(s) {
    for (const q of [...off.queue, ...off.held]) if (!s.docs.has(q.id)) s.docs.set(q.id, Object.freeze({ ...q.data, offlinePending: true, offlineHeld: off.held.includes(q) ? q.error || "Needs review" : undefined }));
  }

  /* ---------- live collections ---------- */
  const cols = new Map(); // name -> { docs: Map, listeners: Set, loading: Promise|null, again: bool }
  const col = (c) => { if (!cols.has(c)) cols.set(c, { docs: new Map(), listeners: new Set(), loading: null, again: false, loaded: false }); return cols.get(c); };
  const meta = { fromCache: false, hasPendingWrites: false };
  const snapDoc = (id, d) => ({ id, exists: d !== undefined, data: () => d, metadata: meta });
  function emit(c) { const s = col(c); s.listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }
  async function refresh(c) {
    const s = col(c);
    if (s.loading) { s.again = true; return s.loading; }
    s.loading = (async () => {
      await off.ready;
      // PR-09: on first open, show the copy saved on this device right away, then update it.
      if (!s.loaded && OFFLINE_COLS.has(c)) {
        const hit = await kv.get("col:" + c);
        if (hit && hit.rows) { s.docs = new Map(hit.rows.map((r) => [r.id, Object.freeze(r.data)])); s.loaded = true; s.cached = true; if (c === "txns") mergePending(s); emit(c); }
      }
      try {
        const rows = await api("GET", "/api/c/" + c);
        s.docs = new Map(rows.map((r) => [r.id, Object.freeze(r.data)]));
        s.loaded = true; s.error = null; s.cached = false;
        saveLater(c);
      } catch (e) {
        if (e && e.code === "offline") {
          const hit = OFFLINE_COLS.has(c) ? await kv.get("col:" + c) : null;
          if (hit || !s.loaded) { s.docs = new Map(((hit && hit.rows) || []).map((r) => [r.id, Object.freeze(r.data)])); s.cached = true; }
          s.loaded = true; s.error = null;
        } else s.error = e;
      }
      if (c === "txns") mergePending(s);
      s.loading = null;
      emit(c);
      if (s.again) { s.again = false; return refresh(c); }
    })();
    return s.loading;
  }

  // PR-09: fetch only the records a change event names, instead of the whole collection.
  async function patch(c, ids) {
    const s = col(c);
    if (s.loading) { s.again = true; return; }
    try {
      const rows = await api("GET", `/api/c/${c}?ids=${ids.map(encodeURIComponent).join(",")}`);
      const got = new Set(rows.map((r) => r.id));
      for (const r of rows) s.docs.set(r.id, Object.freeze(r.data));
      for (const id of ids) if (!got.has(id)) s.docs.delete(id);
      if (c === "txns") mergePending(s);
      saveLater(c);
      emit(c);
    } catch (e) { if (!(e && e.code === "offline")) refresh(c); }
  }
  // The device copy is rewritten at most every few seconds, not on every change.
  // The first copy is written at once, so the app works offline right after it opens.
  const saveTimers = {}, savedOnce = new Set();
  function saveNow(c) {
    const rows = [...col(c).docs].filter(([, d]) => !d.offlinePending).map(([id, d]) => ({ id, data: lean(c, d) }));
    kv.set("col:" + c, { at: Date.now(), rows });
    if (c === "txns") { off.lastSync = Date.now(); kv.set("lastSync", off.lastSync); announce(); }
  }
  function saveLater(c) {
    if (!OFFLINE_COLS.has(c)) return;
    if (!savedOnce.has(c)) { savedOnce.add(c); return saveNow(c); }
    if (saveTimers[c]) return;
    saveTimers[c] = setTimeout(() => { saveTimers[c] = null; saveNow(c); }, 3000);
  }

  // Sends queued offline payments, oldest first. Stops at the first network failure.
  async function flush() {
    await off.ready;
    if (off.syncing || !off.queue.length) return;
    let m; try { m = await me(); } catch (e) { return; }
    off.syncing = true; announce();
    let changed = false;
    try {
      for (const q of [...off.queue]) {
        if (q.by !== m.id) continue; // recorded by another account on this device: wait for them
        try {
          await api("PUT", "/api/c/txns/" + encodeURIComponent(q.id), { data: q.data });
          off.queue = off.queue.filter((x) => x !== q); changed = true;
        } catch (e) {
          if (e && e.code === "offline") break;
          if (e && e.code === "unauthenticated") break;
          if (e && e.status >= 500) break;
          off.queue = off.queue.filter((x) => x !== q);
          off.held.push({ ...q, error: (e && (e.userMsg || e.message)) || "The server refused this record.", heldAt: Date.now() });
          changed = true;
        }
        await saveQueue();
      }
    } finally { off.syncing = false; announce(); }
    if (changed) refresh("txns");
  }
  setInterval(() => { if (off.queue.length) flush(); }, 20000);
  window.addEventListener("online", () => { setOnline(true); flush(); cols.forEach((s, c) => s.listeners.size && refresh(c)); });
  window.addEventListener("offline", () => setOnline(false));
  let es = null;
  function connectEvents() {
    if (es || typeof EventSource === "undefined") return;
    es = new EventSource("/api/events");
    es.addEventListener("change", (ev) => { try { const { c, ids } = JSON.parse(ev.data); if (!cols.has(c)) return; if (Array.isArray(ids) && ids.length && col(c).loaded) patch(c, ids); else refresh(c); } catch (e) {} });
    let first = true;
    es.addEventListener("open", () => { setOnline(true); flush(); if (!first) cols.forEach((s, c) => s.listeners.size && refresh(c)); first = false; });
  }
  // Safety net when live updates are blocked by a proxy (skipped while they work).
  setInterval(() => { if (document.visibilityState === "visible" && !(es && es.readyState === 1)) cols.forEach((s, c) => s.listeners.size && refresh(c)); }, 60000);

  const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "").slice(0, 20) : Math.random().toString(36).slice(2) + Date.now().toString(36));
  function docRef(c, id) {
    return {
      id, path: c + "/" + id,
      async get() { await refresh(c); return snapDoc(id, col(c).docs.get(id)); },
      async set(data, opts) {
        try { await api("PUT", `/api/c/${c}/${encodeURIComponent(id)}`, { data }, opts && opts.restore ? { "X-Restore": "1" } : {}); }
        catch (e) {
          const s = col(c);
          // Payments, sales and returns can wait for signal. An order release can't, because it also updates the order.
          if (!(e && e.code === "offline" && c === "txns" && data && ["payment", "sale", "return"].includes(data.type) && !data.orderId && !s.docs.has(id))) throw e;
          await off.ready;
          const m = await me();
          off.queue.push({ id, by: m.id, at: Date.now(), data: { ...data, offline: { key: id, recordedAt: Date.now() } } });
          await saveQueue();
          mergePending(s); emit(c); announce();
          return;
        }
        await refresh(c);
      },
      async update(data) { await api("PATCH", `/api/c/${c}/${encodeURIComponent(id)}`, { data }); await refresh(c); },
      async delete() { await api("DELETE", `/api/c/${c}/${encodeURIComponent(id)}`); await refresh(c); },
      onSnapshot(next, error) {
        const s = col(c);
        const fn = () => (s.error && !s.loaded ? error && error(s.error) : next(snapDoc(id, s.docs.get(id))));
        s.listeners.add(fn); connectEvents();
        if (s.loaded) setTimeout(fn, 0); else refresh(c);
        return () => s.listeners.delete(fn);
      },
    };
  }
  function colRef(c) {
    return {
      path: c,
      doc: (id) => docRef(c, id || newId()),
      async add(data) { const r = docRef(c, newId()); await r.set(data); return r; },
      async get() { await refresh(c); const docs = [...col(c).docs].map(([id, d]) => snapDoc(id, d)); return { docs, size: docs.length, empty: !docs.length, metadata: meta }; },
      onSnapshot(next, error) {
        const s = col(c);
        const fn = () => {
          if (s.error && !s.loaded) return error && error(s.error);
          const docs = [...s.docs].map(([id, d]) => snapDoc(id, d));
          next({ docs, size: docs.length, empty: !docs.length, metadata: meta, docChanges: () => [] });
        };
        s.listeners.add(fn); connectEvents();
        if (s.loaded) setTimeout(fn, 0); else refresh(c);
        return () => s.listeners.delete(fn);
      },
    };
  }
  const split = (p) => { const i = p.indexOf("/"); return [p.slice(0, i), p.slice(i + 1)]; };
  const db = Object.freeze({
    collection: colRef,
    doc: (p) => { const [c, id] = split(p); return docRef(c, id); },
    async adjustStock(deltas) { await api("POST", "/api/stock", { deltas }); await refresh("products"); },
  });

  /* ---------- people ---------- */
  let meP = null, usersP = null;
  const me = () => (meP = meP || api("GET", "/api/me").then(async (m) => {
    const prev = await kv.get("me");
    if (prev && prev.id !== m.id) { // a different person signed in on this device: drop the old copy, keep unsent payments
      for (const c of OFFLINE_COLS) await kv.set("col:" + c, null);
    }
    kv.set("me", m); return m;
  }).catch(async (e) => { meP = null; const cached = e && e.code === "offline" ? await kv.get("me") : null; if (cached) return cached; throw e; }));
  const users = (force) => (usersP = !force && usersP ? usersP : api("GET", "/api/users"));
  const ADMIN = ["owner", "editor"];
  const user = Object.freeze({
    async isOwner() { return (await me()).role === "owner"; },
    async canEdit() { return ADMIN.includes((await me()).role); },
    async can(name) { const r = (await me()).role; return name === "data.write" ? r !== "viewer" : ADMIN.includes(r); },
    async id() { return (await me()).id; },
    async me() { const m = await me(); return { id: m.id, name: m.name, email: null }; },
    async profiles(ids) {
      let list = await users();
      if (ids.some((id) => !list.find((u) => u.id === id))) list = await users(true);
      return Object.fromEntries(ids.map((id) => { const u = list.find((x) => x.id === id); return [id, { id, name: u ? u.name : "", guest: false }]; }));
    },
  });

  /* ---------- files ---------- */
  const downloads = Object.freeze({
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: /\.csv$/i.test(filename) ? "text/csv" : /\.json$/i.test(filename) ? "application/json" : "application/octet-stream" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      return { status: "saved" };
    },
  });
  const assets = Object.freeze({
    upload: (blob) => api("POST", "/api/assets", blob, { "Content-Type": blob.type || "application/octet-stream" }),
    delete: (id) => api("DELETE", "/api/assets/" + encodeURIComponent(id)),
    fromUrl: (url) => api("POST", "/api/assets/fetch", { url }),
  });

  const NS = { db, user, downloads, assets };
  window.claude = Object.freeze({ use: async (name) => NS[name] || null });

  /* ---------- account helpers used by the Store tab ---------- */
  window.APP = Object.freeze({
    node: true,
    call: (method, url, body) => api(method, url, body),
    newId: () => crypto.randomUUID().replace(/-/g, "").slice(0, 20),
    me: () => { meP = null; return me(); },
    users: () => users(true),
    createUser: (u) => api("POST", "/api/users", u).then((r) => (users(true), r)),
    updateUser: (id, u) => api("PATCH", "/api/users/" + encodeURIComponent(id), u).then((r) => (users(true), r)),
    changePassword: (current, next) => api("POST", "/api/me/password", { current, next }),
    twoStepSetup: () => api("POST", "/api/me/2fa/setup", {}),
    twoStepEnable: (code) => api("POST", "/api/me/2fa/enable", { code }),
    twoStepDisable: (password) => api("POST", "/api/me/2fa/disable", { password }),
    signoutOthers: () => api("POST", "/api/me/signout-others", {}),
    signoutUser: (id) => api("POST", "/api/users/" + encodeURIComponent(id) + "/signout", {}),
    audit: (limit = 150) => api("GET", "/api/audit?limit=" + limit),
    backupFull: () => api("GET", "/api/backup/full"),
    backupStatus: () => api("GET", "/api/backup/status"),
    exportDealer: (id) => api("GET", "/api/dealers/" + encodeURIComponent(id) + "/export"),
    anonymiseDealer: (id) => api("POST", "/api/dealers/" + encodeURIComponent(id) + "/anonymise", {}).then((r) => (refresh("dealers"), refresh("interactions"), r)),
    viewedDealer: (id) => api("POST", "/api/dealers/" + encodeURIComponent(id) + "/viewed", {}).catch(() => {}),
    backupRun: () => api("POST", "/api/backup/run", {}),
    backupRestore: (backup, replace = false) => api("POST", "/api/backup/restore", { backup, replace }),
    // Offline state for the page: { online, pending, held: [{id, data, error}], lastSync, syncing }
    offline: () => ({ online: off.online, pending: off.queue.length, held: off.held.map((h) => ({ id: h.id, data: h.data, error: h.error, heldAt: h.heldAt })), lastSync: off.lastSync, syncing: off.syncing }),
    syncNow: () => flush(),
    // Approval requests for blocked credit sales (FR-084).
    requestApproval: (body) => api("POST", "/api/approvals", body).then((r) => (refresh("approvals"), r)),
    approve: (id, note) => api("POST", `/api/approvals/${encodeURIComponent(id)}/approve`, { note }).then((r) => (["approvals", "txns", "products", "orders"].forEach(refresh), r)),
    reject: (id, note) => api("POST", `/api/approvals/${encodeURIComponent(id)}/reject`, { note }).then((r) => (refresh("approvals"), r)),
    withdraw: (id) => api("POST", `/api/approvals/${encodeURIComponent(id)}/withdraw`, {}).then((r) => (refresh("approvals"), r)),
    retryHeld: async (id, confirm) => {
      const h = off.held.find((x) => x.id === id); if (!h) return;
      off.held = off.held.filter((x) => x !== h);
      off.queue.push({ ...h, error: undefined, data: { ...h.data, offline: { ...h.data.offline, confirmed: !!confirm } } });
      await saveQueue(); announce(); await flush();
    },
    discardHeld: async (id) => {
      off.held = off.held.filter((x) => x.id !== id); off.queue = off.queue.filter((x) => x.id !== id);
      await saveQueue(); col("txns").docs.delete(id); emit("txns"); announce();
    },
    // Signing out wipes the device copy. Unsent payments block sign-out unless discarded.
    logout: async (discard) => {
      await off.ready;
      const unsent = off.queue.length + off.held.length;
      if (unsent && !discard) throw { code: "unsent", userMsg: `${unsent} record${unsent === 1 ? " hasn't" : "s haven't"} synced yet. Connect to the internet first, or tap again to sign out and discard ${unsent === 1 ? "it" : "them"}.` };
      await kv.clear();
      try {
        const reg = await navigator.serviceWorker?.getRegistration(); reg?.active?.postMessage("clear");
        // A shared phone stops getting this person's notifications.
        const sub = await reg?.pushManager?.getSubscription();
        if (sub) { await api("POST", "/api/push/unsubscribe", { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      } catch (e) {}
      try { await api("POST", "/api/logout"); } catch (e) {}
      location.href = "/login";
    },
  });
  if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
