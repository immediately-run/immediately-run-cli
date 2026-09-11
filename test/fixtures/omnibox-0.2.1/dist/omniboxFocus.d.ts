type OmniboxVariant = 'hero' | 'nav' | 'new';
interface OmniboxHandle {
    /** Move keyboard focus into the field. */
    focus: () => void;
    /** Bring the field into view. Absent for fields that are always on screen. */
    reveal?: () => void;
}
/** Focus the hero omnibox (no-op when no hero variant is mounted). */
declare function focusHeroOmnibox(): void;
/** Scroll the hero omnibox into view and focus it — what a "paste a repo" CTA
 *  further down the page does. No-op when no hero omnibox is mounted. */
declare function revealHeroOmnibox(): void;
/** Focus whichever omnibox is mounted — the page's own field first (`new`), then
 *  the hero, then the nav field, which is on every route. */
declare function focusOmnibox(): void;
/** Publish a mounted omnibox; the returned function unregisters exactly this one. */
declare function registerOmniboxFocus(variant: OmniboxVariant, handle: OmniboxHandle): () => void;

export { type OmniboxHandle, type OmniboxVariant, focusHeroOmnibox, focusOmnibox, registerOmniboxFocus, revealHeroOmnibox };
