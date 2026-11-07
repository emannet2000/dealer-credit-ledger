/* Connects the ledger page to the Node.js server.
   It provides the same small data interface the page was written against
   (collections, documents, live snapshots, users, photos, downloads). */
(() => {
  "use strict";
  const retryKeys = new Map();
  const retryId = () => crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  async function api(method, url, body, headers = {}) {
    let fingerprint;
    if (!["GET", "HEAD"].includes(method)) {
      fingerprint = method + url + JSON.stringify(body);
      if (!retryKeys.has(fingerprint)) retryKeys.set(fingerprint, retryId());
      headers = { "Idempotency-Key": retryKeys.get(fingerprint), ...headers };
    }
    const isBlob = typeof Blob !== "undefined" && body instanceof Blob;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const r = await fetch(url, {
        method, credentials: "same-origin", signal: controller.signal,
        headers: { ...(body !== undefined && !isBlob ? { "Content-Type": "application/json" } : {}), ...headers },
        body: body === undefined ? undefined : isBlob ? body : JSON.stringify(body),
      });
      if (r.status === 401) { location.href = "/login"; throw { code: "unauthenticated", message: "Signed out" }; }
      const data = await r.json();
      if (!r.ok) throw { code: data.code || (r.status === 413 ? "too_large" : "unavailable"), message: data.message || "Request failed", userMsg: data.message };
      if (fingerprint) retryKeys.delete(fingerprint);
      return data;
    } catch (e) {
      if (controller.signal.aborted) throw { code: "unavailable", message: "The server took too long to respond. Check your connection and retry." };
      throw e;
    } finally {
      clearTimeout(timeout);
    }
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
      try {
        const rows = await api("GET", "/api/c/" + c);
        s.docs = new Map(rows.map((r) => [r.id, Object.freeze(Object.defineProperty({ ...r.data }, "_version", { value: r.version }))]));
        s.loaded = true; s.error = null;
      } catch (e) { s.error = e; }
      s.loading = null;
      emit(c);
      if (s.again) { s.again = false; return refresh(c); }
    })();
    return s.loading;
  }
  let es = null;
  function connectEvents() {
    if (es || typeof EventSource === "undefined") return;
    es = new EventSource("/api/events");
    es.addEventListener("change", (ev) => { try { const { c } = JSON.parse(ev.data); if (cols.has(c)) refresh(c); } catch (e) {} });
    let first = true;
    es.addEventListener("open", () => { if (!first) cols.forEach((s, c) => s.listeners.size && refresh(c)); first = false; });
  }
  // Safety net in case live updates are blocked by a proxy.
  setInterval(() => { if (document.visibilityState === "visible") cols.forEach((s, c) => s.listeners.size && refresh(c)); }, 60000);

  const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "").slice(0, 20) : Math.random().toString(36).slice(2) + Date.now().toString(36));
  function docRef(c, id) {
    return {
      id, path: c + "/" + id,
      async get() { await refresh(c); if (col(c).error) throw col(c).error; return snapDoc(id, col(c).docs.get(id)); },
      async set(data, opts = {}) { const result = await api("PUT", `/api/c/${c}/${encodeURIComponent(id)}`, { data }, { ...(opts.restore ? { "X-Restore": "1" } : {}), ...((opts.version ?? col(c).docs.get(id)?._version) ? { "If-Match": String(opts.version ?? col(c).docs.get(id)._version) } : {}) }); await refresh(c); if (["txns", "moves", "orders"].includes(c)) await Promise.all(["products", "orders", "txns", "approvals"].filter(k => k !== c && cols.has(k)).map(refresh)); return result; },
      async update(data) { await api("PATCH", `/api/c/${c}/${encodeURIComponent(id)}`, { data }, col(c).docs.get(id)?._version ? { "If-Match": String(col(c).docs.get(id)._version) } : {}); await refresh(c); },
      async delete() { await api("DELETE", `/api/c/${c}/${encodeURIComponent(id)}`); await refresh(c); },
      onSnapshot(next, error) {
        const s = col(c);
        const fn = () => (s.error ? error && error(s.error) : next(snapDoc(id, s.docs.get(id))));
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
      async get() { await refresh(c); if (col(c).error) throw col(c).error; const docs = [...col(c).docs].map(([id, d]) => snapDoc(id, d)); return { docs, size: docs.length, empty: !docs.length, metadata: meta }; },
      onSnapshot(next, error) {
        const s = col(c);
        const fn = () => {
          if (s.error) return error && error(s.error);
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
  });

  /* ---------- people ---------- */
  let meP = null, usersP = null;
  const me = () => (meP = meP || api("GET", "/api/me"));
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
  });

  const NS = { db, user, downloads, assets };
  window.claude = Object.freeze({ use: async (name) => NS[name] || null });

  /* ---------- account helpers used by the Store tab ---------- */
  window.APP = Object.freeze({
    node: true,
    me,
    users: () => users(true),
    createUser: (u) => api("POST", "/api/users", u).then((r) => (users(true), r)),
    updateUser: (id, u) => api("PATCH", "/api/users/" + encodeURIComponent(id), u).then((r) => (users(true), r)),
    changePassword: (current, next) => api("POST", "/api/me/password", { current, next }),
    request: api,
    backup: () => api("GET", "/api/backup"),
    previewImport: (kind, input) => api("POST", "/api/imports/preview", { kind, input }),
    confirmImport: async id => { const out = await api("POST", "/api/imports/" + id + "/confirm", {}); await Promise.all([...cols.keys()].map(refresh)); return out; },
    audit: (limit = 150) => api("GET", "/api/audit?limit=" + limit),
    logout: () => api("POST", "/api/logout").finally(() => (location.href = "/login")),
  });
})();
