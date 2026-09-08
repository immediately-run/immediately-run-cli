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
export {
  focusHeroOmnibox,
  focusOmnibox,
  registerOmniboxFocus,
  revealHeroOmnibox
};
//# sourceMappingURL=omniboxFocus.js.map