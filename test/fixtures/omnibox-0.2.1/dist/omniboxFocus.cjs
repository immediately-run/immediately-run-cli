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
var omniboxFocus_exports = {};
__export(omniboxFocus_exports, {
  focusHeroOmnibox: () => focusHeroOmnibox,
  focusOmnibox: () => focusOmnibox,
  registerOmniboxFocus: () => registerOmniboxFocus,
  revealHeroOmnibox: () => revealHeroOmnibox
});
module.exports = __toCommonJS(omniboxFocus_exports);
const stack = [];
function current(variant) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i].variant === variant) return stack[i].handle;
  }
  return void 0;
}
function focusHeroOmnibox() {
  current("hero")?.focus();
}
function revealHeroOmnibox() {
  const hero = current("hero");
  if (!hero) return;
  hero.reveal?.();
  hero.focus();
}
function focusOmnibox() {
  (current("new") ?? current("hero") ?? current("nav"))?.focus();
}
function registerOmniboxFocus(variant, handle) {
  const registration = { variant, handle };
  stack.push(registration);
  return () => {
    const at = stack.indexOf(registration);
    if (at !== -1) stack.splice(at, 1);
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  focusHeroOmnibox,
  focusOmnibox,
  registerOmniboxFocus,
  revealHeroOmnibox
});
//# sourceMappingURL=omniboxFocus.cjs.map