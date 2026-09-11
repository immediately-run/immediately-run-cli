import * as react from 'react';
import { ReactNode } from 'react';
import { OmniboxVariant } from './omniboxFocus.js';

interface AppHit {
    key: string;
    name: string;
    category: string;
    blurb: string;
    /** The repository the row opens — an org repo under immediately-run. */
    repo: string;
    /** The PLATFORM path the row opens, e.g. `/present/github/immediately-run/todo/main/files/src/App.tsx`.
     *  Supplied by the consumer's `apps` source beside its own route builder, so the
     *  package carries no second spelling of any route family. Rendered through
     *  `PlatformLink` (host-space href, frame-escaping). */
    path: string;
    /** Opaque to the package: a consumer's `renderChip` reads it back. */
    provenance?: unknown;
}
interface DocHit {
    key: string;
    title: string;
    lead: string;
    /** A real href — copy-link, middle-click and open-in-new-tab all resolve it. */
    href: string;
    /** The app-space route behind `href`, when the consumer renders the row through
     *  its own in-app link (`renderDoc`). Opaque to the package. */
    to?: string;
}
/** The data seams. Absent sources simply yield no rows of their kind; an omnibox
 *  with no `hits` at all is the launch grammar only (what the Home app renders). */
interface OmniboxHitSources {
    /** Candidate app hits for a query; the package ranks, filters and orders them. */
    apps?: (query: string) => AppHit[];
    /** Matched doc hits for a query, best-first, capped by the source. */
    docs?: (query: string) => DocHit[];
}
/** What a `renderDoc` anchor must spread: the combobox's option identity and state. */
interface DocAnchorProps {
    id: string;
    className: string;
    role: 'option';
    'aria-selected': boolean;
}
interface OmniboxProps {
    variant: OmniboxVariant;
    /** Nav variant only: true while the hero omnibox is mounted (`/`), so the
     *  nav field renders as the shortcut that focuses it. Derived by the caller
     *  from the route — render-time data, not an effect. */
    heroShortcut?: boolean;
    /** App-directory and docs hit sources. Absent → the launch grammar only. */
    hits?: OmniboxHitSources;
    /** Renders the app row's trailing chip (e.g. a provenance chip). The chip is a
     *  site component with site data types, so the package renders what it is given. */
    renderChip?: (hit: AppHit) => ReactNode;
    /** Renders a doc ROW. `anchorProps` carries the combobox contract (the option's
     *  id, class, role and aria-selected) — spread them onto the anchor you render so
     *  the arrow-key highlight and the Enter walk keep working. The fallback is a
     *  plain `<a href>` — its href is real and resolvable, but on-host a plain click
     *  navigates the sandboxed FRAME to the target instead of routing the app, so a
     *  consumer with an in-app link (the landing page's SiteLink) should supply this. */
    renderDoc?: (hit: DocHit, anchorProps: DocAnchorProps) => ReactNode;
}
declare function Omnibox({ variant, heroShortcut, hits, renderChip, renderDoc }: OmniboxProps): react.JSX.Element;

export { type AppHit, type DocAnchorProps, type DocHit, type OmniboxHitSources, type OmniboxProps, Omnibox as default };
