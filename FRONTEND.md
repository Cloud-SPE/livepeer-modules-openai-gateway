# FRONTEND

DOM, CSS, and build conventions for the three SPAs under `web/`.

## Zero-build, importmaps, Lit

All three SPAs (`web/site/`, `web/portal/`, `web/admin/`) are
zero-build: no Vite, no esbuild, no bundler. Dependencies load via
`<script type="importmap">` from [esm.sh](https://esm.sh/).

Why: agents can edit and reload without a build step. The runtime is the
source. A small `dev-server.js` per SPA serves static files and proxies
`/api/*` and `/v1/*` to the gateway.

## DOM invariants

Hard rules, enforced by reviewer attention (lint coming later):

1. **Light DOM only.** No `attachShadow()`, no `<slot>`, no shadow trees.
   Lit components use `createRenderRoot() { return this; }` to render
   into light DOM. Reason: CSS-in-shadow is opaque to agents and to the
   browser's accessibility tree.
2. **Semantic HTML only.** `<button>` not `<div role="button">`.
   `<form>` for submissions. `<nav>`, `<main>`, `<header>`, `<footer>`
   in page layouts. Headings (`h1`–`h6`) in document order.
3. **No inline CSS.** No `style="…"` attributes. No `<style>` blocks in
   component render functions.
4. **No inline event handlers.** No `onclick="…"`. Use Lit's `@event`
   binding syntax.

## CSS conventions

- Styles live in checked-in `.css` files, one per SPA: `site/index.css`,
  `portal/portal.css`, `admin/admin.css`.
- Use [CSS `@layer`](https://developer.mozilla.org/en-US/docs/Web/CSS/@layer)
  for cascading control. Layer order: `reset, base, components, utilities,
  overrides`.
- Custom properties (`--token-name`) for all themeable values. A single
  `:root { … }` block per SPA owns the design tokens.
- No CSS frameworks (no Tailwind, no Bootstrap). No CSS-in-JS.

## Component shape

```js
// web/portal/components/cc-api-key-row.js
import { LitElement, html } from 'lit';

export class CcApiKeyRow extends LitElement {
  static properties = {
    apiKey: { type: Object },
  };

  createRenderRoot() {
    return this; // light DOM
  }

  render() {
    return html`
      <article class="api-key-row">
        <h3>${this.apiKey.label}</h3>
        <button @click=${this.#onRevoke}>Revoke</button>
      </article>
    `;
  }

  #onRevoke() {
    this.dispatchEvent(new CustomEvent('revoke', { detail: this.apiKey.id }));
  }
}

customElements.define('cc-api-key-row', CcApiKeyRow);
```

Component file naming: kebab-case prefix `cc-` (component cluster).

## Routing

Hash-based or History-API; no React Router, no framework router. Each
SPA picks one and is consistent within itself.

## Branding

The marketing site (`web/site/`) shows "OpenAI Service" as the product
name. Anyone deploying this repo replaces that string in
`site/index.html` and `site/index.css` — no build-time templating yet.

## Accessibility

Every form input has a `<label>`. Every interactive element is keyboard-
operable. Color contrast meets WCAG AA. No CSS that disables focus
outlines without providing an alternative.

## What we accept

- Slightly more verbose markup than a framework-driven SPA.
- Slower initial cold load than a bundled app (esm.sh is CDN-backed; this
  is usually fine).
- No SSR. SPAs are CSR-only.
- No router library — hand-roll per SPA.

## What we do NOT accept

- Heavy frameworks (React, Vue, Angular, Svelte).
- Build steps that produce bundles in source control.
- Inline styling.
- Shadow DOM.
