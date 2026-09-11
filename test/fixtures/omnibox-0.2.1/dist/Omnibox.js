import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { Fragment as Fragment2, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import "./omnibox.css";
import { parseLaunch, PROVIDERS } from "./launch";
import { PlatformLink } from "@immediately-run/sdk/platformLink";
import { focusHeroOmnibox, registerOmniboxFocus } from "./omniboxFocus";
function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
function appScore(hit, q) {
  if (hit.name.toLowerCase().startsWith(q)) return 4;
  if (hit.name.toLowerCase().includes(q)) return 3;
  if (hit.repo.toLowerCase().includes(q)) return 2;
  if (hit.blurb.toLowerCase().includes(q)) return 1;
  if (hit.category.toLowerCase().includes(q)) return 0;
  return -1;
}
function Omnibox({ variant, heroShortcut = false, hits, renderChip, renderDoc }) {
  const isMobile = useMediaQuery("(max-width: 720px)");
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const inputRef = useRef(null);
  const outerRef = useRef(null);
  const listId = useId();
  const inputId = `${listId}-input`;
  const helperId = useId();
  const noticeId = useId();
  const warnedSources = useRef(/* @__PURE__ */ new Set());
  const callSource = useCallback(
    function callSource2(kind, source, q) {
      try {
        return source(q);
      } catch (error) {
        if (!warnedSources.current.has(kind)) {
          warnedSources.current.add(kind);
          console.warn(`omnibox: the "${String(kind)}" hit source threw; its rows are empty for this query`, error);
        }
        return [];
      }
    },
    []
  );
  const parsed = useMemo(() => parseLaunch(query), [query]);
  const runnable = parsed.kind === "location" || parsed.kind === "platform-url";
  const runPath = parsed.kind === "location" ? parsed.presentPath : parsed.kind === "platform-url" ? parsed.path : void 0;
  const panelOpen = query.trim() !== "";
  const [prevQuery, setPrevQuery] = useState(query);
  if (prevQuery !== query) {
    setPrevQuery(query);
    setHighlight(-1);
  }
  const notice = parsed.kind === "unknown-provider" ? `${parsed.provider.charAt(0).toUpperCase()}${parsed.provider.slice(1)} is not supported yet. GitHub works today.` : "";
  const helper = variant === "new" ? "the repo you just created" : "Accepts provider:namespace/repository@ref \xB7 GitHub is the first provider";
  const appHits = useMemo(() => {
    if (!panelOpen || !hits?.apps) return [];
    const q = query.trim().toLowerCase();
    return callSource("apps", hits.apps, q).map((hit) => ({ hit, score: appScore(hit, q) })).filter(({ score }) => score >= 0).sort((a, b) => b.score - a.score).map(({ hit }) => hit);
  }, [panelOpen, query, hits, callSource]);
  const docHits = useMemo(() => {
    if (!panelOpen || !hits?.docs) return [];
    return callSource("docs", hits.docs, query.trim().toLowerCase());
  }, [panelOpen, query, hits, callSource]);
  const locationRow = parsed.kind === "location" ? parsed : void 0;
  const hasResults = Boolean(locationRow) || appHits.length > 0 || docHits.length > 0;
  const options = useMemo(() => {
    const list = [];
    if (locationRow) list.push({ id: `${listId}-opt-location`, label: locationRow.display });
    for (const hit of appHits) list.push({ id: `${listId}-opt-${hit.key}`, label: hit.name });
    for (const hit of docHits) list.push({ id: `${listId}-opt-doc-${hit.key}`, label: hit.title });
    return list;
  }, [locationRow, appHits, docHits, listId]);
  useEffect(
    () => registerOmniboxFocus(variant, {
      focus: () => inputRef.current?.focus(),
      reveal: () => outerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
    }),
    [variant]
  );
  const onKeyDown = useCallback(
    (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!panelOpen || options.length === 0) return;
        e.preventDefault();
        setHighlight((h) => {
          if (h === -1) return e.key === "ArrowDown" ? 0 : options.length - 1;
          return (h + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        });
        return;
      }
      if (e.key === "Enter") {
        if (highlight >= 0 && highlight < options.length) {
          e.preventDefault();
          document.getElementById(options[highlight].id)?.click();
          return;
        }
        if (runnable) {
          e.preventDefault();
          document.getElementById(`${listId}-run`)?.click();
        }
        return;
      }
      if (e.key === "Escape") {
        setQuery("");
        setHighlight(-1);
        inputRef.current?.blur();
      }
    },
    [panelOpen, options, highlight, runnable, listId]
  );
  const chip = /* @__PURE__ */ jsx("span", { className: "omnibox-chip", "aria-hidden": Object.keys(PROVIDERS).length === 1 || void 0, children: Object.keys(PROVIDERS).length === 1 ? (
    // One provider: a static label with no caret — NOT a dropdown of
    // providers that do not exist.
    /* @__PURE__ */ jsx("span", { className: "omnibox-chip-label", children: "github" })
  ) : /* @__PURE__ */ jsx("select", { className: "omnibox-chip-select", "aria-label": "Provider", children: Object.keys(PROVIDERS).map((p) => /* @__PURE__ */ jsx("option", { value: p, children: p }, p)) }) });
  const run = runPath !== void 0 ? /* @__PURE__ */ jsxs(
    PlatformLink,
    {
      id: `${listId}-run`,
      className: "omnibox-run",
      path: runPath,
      "aria-label": "Run",
      children: [
        /* @__PURE__ */ jsx("span", { className: "omnibox-run-label", children: "Run" }),
        /* @__PURE__ */ jsx("span", { className: "omnibox-run-arrow", "aria-hidden": "true", children: "\u2192" })
      ]
    }
  ) : /* @__PURE__ */ jsxs(
    "button",
    {
      id: `${listId}-run`,
      type: "button",
      className: "omnibox-run",
      "aria-disabled": "true",
      "aria-describedby": `${helperId} ${noticeId}`,
      onClick: (e) => e.preventDefault(),
      children: [
        /* @__PURE__ */ jsx("span", { className: "omnibox-run-label", children: "Run" }),
        /* @__PURE__ */ jsx("span", { className: "omnibox-run-arrow", "aria-hidden": "true", children: "\u2192" })
      ]
    }
  );
  const field = /* @__PURE__ */ jsxs("div", { className: `omnibox omnibox--${variant}`, children: [
    /* @__PURE__ */ jsxs("div", { className: "omnibox-row", children: [
      chip,
      /* @__PURE__ */ jsx(
        "input",
        {
          ref: inputRef,
          id: inputId,
          className: "omnibox-input",
          type: "text",
          role: "combobox",
          "aria-autocomplete": "list",
          "aria-expanded": panelOpen,
          "aria-controls": panelOpen ? listId : void 0,
          "aria-activedescendant": highlight >= 0 ? options[highlight]?.id : void 0,
          "aria-describedby": `${helperId} ${noticeId}`,
          "aria-invalid": notice ? true : void 0,
          placeholder: isMobile ? "Paste a repo or an app name" : "owner/repo@branch, a GitHub URL, or an app name",
          value: query,
          onChange: (e) => setQuery(e.target.value),
          onKeyDown
        }
      ),
      run
    ] }),
    /* @__PURE__ */ jsx("p", { className: "omnibox-helper", id: helperId, children: notice || helper }),
    /* @__PURE__ */ jsx("p", { className: "omnibox-visually-hidden", id: noticeId, "aria-live": "polite", children: notice }),
    panelOpen && /* @__PURE__ */ jsx("div", { className: "omnibox-panel", id: listId, role: "listbox", "aria-label": "Results", children: hasResults ? /* @__PURE__ */ jsxs(Fragment, { children: [
      locationRow && /* @__PURE__ */ jsx("div", { className: "omnibox-group", role: "group", "aria-label": "Run from source", children: /* @__PURE__ */ jsxs(
        PlatformLink,
        {
          id: `${listId}-opt-location`,
          className: "omnibox-option",
          role: "option",
          "aria-selected": highlight === 0,
          path: locationRow.presentPath,
          children: [
            /* @__PURE__ */ jsx("span", { className: "omnibox-option-name", children: locationRow.display }),
            /* @__PURE__ */ jsx("span", { className: "omnibox-option-action", children: "Run" })
          ]
        }
      ) }),
      appHits.length > 0 && /* @__PURE__ */ jsx("div", { className: "omnibox-group", role: "group", "aria-label": "Apps in the directory", children: appHits.map((hit) => {
        const idx = options.findIndex((o) => o.id === `${listId}-opt-${hit.key}`);
        return /* @__PURE__ */ jsxs(
          PlatformLink,
          {
            id: `${listId}-opt-${hit.key}`,
            className: "omnibox-option",
            role: "option",
            "aria-selected": highlight === idx,
            path: hit.path,
            children: [
              /* @__PURE__ */ jsx("span", { className: "omnibox-option-name", children: hit.name }),
              /* @__PURE__ */ jsx("span", { className: "omnibox-option-cat", children: hit.category }),
              /* @__PURE__ */ jsx("span", { className: "omnibox-option-blurb", children: hit.blurb }),
              renderChip?.(hit)
            ]
          },
          hit.key
        );
      }) }),
      docHits.length > 0 && /* @__PURE__ */ jsx("div", { className: "omnibox-group", role: "group", "aria-label": "Docs and tutorials", children: docHits.map((hit) => {
        const idx = options.findIndex((o) => o.id === `${listId}-opt-doc-${hit.key}`);
        const anchorProps = {
          id: `${listId}-opt-doc-${hit.key}`,
          className: "omnibox-option",
          role: "option",
          "aria-selected": highlight === idx
        };
        if (renderDoc) {
          return /* @__PURE__ */ jsx(Fragment2, { children: renderDoc(hit, anchorProps) }, hit.key);
        }
        return /* @__PURE__ */ jsxs(
          "a",
          {
            id: `${listId}-opt-doc-${hit.key}`,
            className: "omnibox-option",
            role: "option",
            "aria-selected": highlight === idx,
            href: hit.href,
            children: [
              /* @__PURE__ */ jsx("span", { className: "omnibox-option-name", children: hit.title }),
              /* @__PURE__ */ jsx("span", { className: "omnibox-option-blurb", children: hit.lead })
            ]
          },
          hit.key
        );
      }) })
    ] }) : /* @__PURE__ */ jsx("div", { className: "omnibox-empty", children: "Nothing matched. Try an app name, or paste a repo." }) })
  ] });
  if (variant === "nav" && heroShortcut) {
    return /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        className: "omnibox-nav-button",
        onClick: () => focusHeroOmnibox(),
        "aria-label": "Search apps and docs, or paste a repo",
        children: [
          /* @__PURE__ */ jsx("span", { className: "omnibox-nav-button-label", children: "Search" }),
          /* @__PURE__ */ jsx("span", { className: "kbd", children: "\u2318K" })
        ]
      }
    );
  }
  return /* @__PURE__ */ jsxs("div", { className: `omnibox-outer omnibox-outer--${variant}`, ref: outerRef, children: [
    /* @__PURE__ */ jsx("label", { className: "omnibox-visually-hidden", htmlFor: inputId, children: "Paste a repo, or search apps and docs" }),
    field
  ] });
}
var Omnibox_default = Omnibox;
export {
  Omnibox_default as default
};
//# sourceMappingURL=Omnibox.js.map