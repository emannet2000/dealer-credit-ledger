"use strict";
// Downloads a product picture from an internet link on the server, because the
// browser cannot read images from other sites. Guards against server-side request
// forgery: only http(s) on standard ports, and every address the host name resolves
// to (checked at connect time, on every redirect) must be public.
const http = require("http");
const https = require("https");
const dns = require("dns");
const net = require("net");

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_HTML = 1024 * 1024;
const TIMEOUT_MS = 12000;
const MAX_REDIRECTS = 4;

const blocked = new net.BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]])
  blocked.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["2001:db8::", 32]])
  blocked.addSubnet(a, p, "ipv6");

function isBlockedAddress(ip) {
  const v = net.isIP(ip);
  if (!v) return true;
  if (v === 6) {
    const m = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
    if (m) return blocked.check(m[1], "ipv4");
    return blocked.check(ip, "ipv6");
  }
  return blocked.check(ip, "ipv4");
}

class FetchError extends Error {
  constructor(message, code = "fetch_failed") { super(message); this.code = code; }
}

function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.slice(0, 6).toString("latin1"))) return "image/gif";
  if (buf.length >= 12 && buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

// Google/Bing image-result links carry the real picture in a query parameter.
function unwrap(u) {
  try {
    const url = new URL(u);
    for (const k of ["imgurl", "mediaurl", "url"]) {
      const v = url.searchParams.get(k);
      if (v && /^https?:\/\//i.test(v) && /google\.|bing\.com/i.test(url.hostname)) return v;
    }
  } catch {}
  return u;
}

function parseUrl(raw, allowPrivate) {
  let url;
  try { url = new URL(String(raw || "").trim()); } catch { throw new FetchError("That doesn't look like a web link.", "invalid_url"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new FetchError("Use a link that starts with http:// or https://.", "invalid_url");
  if (url.username || url.password) throw new FetchError("Links with a user name or password aren't allowed.", "invalid_url");
  if (!allowPrivate && url.port && !["80", "443"].includes(url.port)) throw new FetchError("Only links on the standard web ports are allowed.", "blocked");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate && (net.isIP(host) ? isBlockedAddress(host) : /(^|\.)(localhost|local|internal|lan|home\.arpa)$/i.test(host)))
    throw new FetchError("Links to private or local network addresses aren't allowed.", "blocked");
  return url;
}

function safeLookup(allowPrivate) {
  return (hostname, options, cb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!allowPrivate && (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))))
        return cb(new FetchError("Links to private or local network addresses aren't allowed.", "blocked"));
      if (options && options.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

function get(url, { allowPrivate, deadline }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const left = deadline - Date.now();
    if (left <= 0) return reject(new FetchError("The website took too long to respond.", "timeout"));
    const req = mod.get(url, {
      lookup: safeLookup(allowPrivate),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DealerCreditLedger/1.0; product photo import)", Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.9,text/html;q=0.5,*/*;q=0.1" },
      timeout: left,
    }, (res) => resolve(res));
    req.on("timeout", () => req.destroy(new FetchError("The website took too long to respond.", "timeout")));
    req.on("error", (e) => reject(e instanceof FetchError ? e : new FetchError(e.code === "ENOTFOUND" ? "That website couldn't be found." : "Couldn't reach that website.", "fetch_failed")));
  });
}

function readBody(res, limit, deadline) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const timer = setTimeout(() => { res.destroy(); reject(new FetchError("The website took too long to send the picture.", "timeout")); }, Math.max(1, deadline - Date.now()));
    res.on("data", (c) => { size += c.length; if (size > limit) { clearTimeout(timer); res.destroy(); reject(new FetchError("That picture is larger than 8 MB.", "too_large")); } else chunks.push(c); });
    res.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    res.on("error", () => { clearTimeout(timer); reject(new FetchError("The download was interrupted.", "fetch_failed")); });
  });
}

// Finds the picture a product page advertises for link previews.
function pageImage(html, base) {
  const metas = html.match(/<meta\b[^>]*>/gi) || [];
  for (const key of ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]) {
    for (const m of metas) {
      const name = (m.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
      const content = (m.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (name && content && name.toLowerCase() === key) {
        try { return new URL(content.replace(/&amp;/g, "&"), base).toString(); } catch {}
      }
    }
  }
  const link = html.match(/<link\b[^>]*rel\s*=\s*["']image_src["'][^>]*>/i);
  const href = link && (link[0].match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
  if (href) { try { return new URL(href, base).toString(); } catch {} }
  return null;
}

async function fetchImage(raw, { allowPrivate = false } = {}) {
  const deadline = Date.now() + TIMEOUT_MS;
  let url = parseUrl(unwrap(raw), allowPrivate);
  let fromPage = false;
  for (let hop = 0; hop <= MAX_REDIRECTS + 1; hop++) {
    const res = await get(url, { allowPrivate, deadline });
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      if (hop >= MAX_REDIRECTS) throw new FetchError("That link redirects too many times.", "fetch_failed");
      url = parseUrl(new URL(res.headers.location, url).toString(), allowPrivate);
      continue;
    }
    if (res.statusCode !== 200) { res.resume(); throw new FetchError(`The website answered with an error (${res.statusCode}).`, "fetch_failed"); }
    const declared = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (declared === "text/html" || declared === "application/xhtml+xml") {
      const html = (await readBody(res, MAX_HTML, deadline).catch(() => Buffer.alloc(0))).toString("utf8");
      const img = !fromPage && pageImage(html, url);
      if (!img) throw new FetchError("That link is a web page without a product picture. Open the picture itself and copy its address.", "not_image");
      fromPage = true;
      url = parseUrl(img, allowPrivate);
      continue;
    }
    const declaredLen = Number(res.headers["content-length"]);
    if (declaredLen > MAX_BYTES) { res.destroy(); throw new FetchError("That picture is larger than 8 MB.", "too_large"); }
    const body = await readBody(res, MAX_BYTES, deadline);
    const type = sniff(body);
    if (!type) throw new FetchError("That link isn't a JPG, PNG, WebP or GIF picture.", "not_image");
    return { body, contentType: type, source: url.toString() };
  }
  throw new FetchError("Couldn't get a picture from that link.", "fetch_failed");
}

module.exports = { fetchImage, FetchError, isBlockedAddress, pageImage, unwrap };
