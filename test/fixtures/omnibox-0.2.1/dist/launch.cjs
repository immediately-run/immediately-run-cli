"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var launch_exports = {};
__export(launch_exports, {
  PROVIDERS: () => PROVIDERS,
  parseLaunch: () => parseLaunch
});
module.exports = __toCommonJS(launch_exports);
const PROVIDERS = {
  github: "github.com"
};
const DEFAULT_PROVIDER = "github";
function presentPathOf(provider, namespace, repository, ref) {
  const base = `/present/${provider}/${namespace}/${repository}`;
  return ref ? `${base}/${encodeURIComponent(ref)}` : base;
}
function location(provider, namespace, repository, ref) {
  const display = ref ? `${provider}:${namespace}/${repository}@${ref}` : `${provider}:${namespace}/${repository}`;
  return { kind: "location", provider, namespace, repository, ...ref ? { ref } : {}, display, presentPath: presentPathOf(provider, namespace, repository, ref) };
}
function providerLabel(hostname) {
  return hostname.replace(/^www\./, "").split(".")[0];
}
function parseTuple(rest, provider) {
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const namespace = rest.slice(0, slash);
  const tail = rest.slice(slash + 1);
  if (!namespace || !tail) return null;
  const at = tail.indexOf("@");
  const repository = at === -1 ? tail : tail.slice(0, at);
  const ref = at === -1 ? void 0 : tail.slice(at + 1);
  if (!repository || repository.includes("/")) return null;
  if (ref !== void 0 && !ref) return null;
  return location(provider, namespace, repository, ref);
}
function parseLaunch(input, defaultProvider = DEFAULT_PROVIDER) {
  const raw = input.trim();
  if (!raw) return { kind: "text", query: raw };
  if (/^https?:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return { kind: "text", query: raw };
    }
    const host = url.hostname.toLowerCase();
    if (host === "immediately.run" || host.endsWith(".immediately.run")) {
      if (/^\/(present|edit)(\/|$)/.test(url.pathname)) {
        return { kind: "platform-url", path: url.pathname + url.search + url.hash };
      }
      return { kind: "text", query: raw };
    }
    const providerEntry = Object.entries(PROVIDERS).find(([, urlHost]) => urlHost === host);
    if (providerEntry) {
      const [provider] = providerEntry;
      const segs2 = url.pathname.split("/").filter(Boolean);
      if (segs2.length < 2) return { kind: "text", query: raw };
      const [namespace, repo0] = segs2;
      const repo = repo0.endsWith(".git") ? repo0.slice(0, -4) : repo0;
      if (!repo) return { kind: "text", query: raw };
      if (segs2.length > 2) {
        const [marker, ...extra] = segs2.slice(2);
        if (marker === "tree" && extra.length > 0) {
          return location(provider, namespace, repo, extra.join("/"));
        }
        if (marker === "blob" && extra.length > 0) {
          return location(provider, namespace, repo, extra[0]);
        }
        return { kind: "text", query: raw };
      }
      return location(provider, namespace, repo);
    }
    const segs = url.pathname.split("/").filter(Boolean);
    if (segs.length >= 2) return { kind: "unknown-provider", provider: providerLabel(host) };
    return { kind: "text", query: raw };
  }
  const colon = raw.indexOf(":");
  if (colon > 0 && !raw.slice(0, colon).includes("/")) {
    const provider = raw.slice(0, colon).toLowerCase();
    const rest = raw.slice(colon + 1);
    if (provider in PROVIDERS) {
      const parsed = parseTuple(rest, provider);
      return parsed ?? { kind: "text", query: raw };
    }
    return { kind: "unknown-provider", provider };
  }
  const tuple = parseTuple(raw, defaultProvider);
  if (tuple) return tuple;
  return { kind: "text", query: raw };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PROVIDERS,
  parseLaunch
});
//# sourceMappingURL=launch.cjs.map