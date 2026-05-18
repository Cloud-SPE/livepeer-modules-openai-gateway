import { LitElement, html } from 'lit';
import { api, getToken, setToken } from '/lib/api.js';

import './cc-token-prompt.js';
import './cc-network-health.js';
import './cc-waitlist-queue.js';
import './cc-users.js';
import './cc-usage.js';
import './cc-registry.js';

const ROUTES = ['waitlist', 'users', 'usage', 'health', 'registry'];

class CcApp extends LitElement {
  static properties = {
    route: { state: true },
    authed: { state: true },
    checking: { state: true },
  };

  constructor() {
    super();
    this.route = readRoute();
    this.authed = false;
    this.checking = true;
  }

  createRenderRoot() { return this; }

  async connectedCallback() {
    super.connectedCallback();
    window.addEventListener('hashchange', this.#onHash);
    window.addEventListener('cc-token', this.#onTokenChange);
    await this.#check();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this.#onHash);
    window.removeEventListener('cc-token', this.#onTokenChange);
  }

  #onHash = () => { this.route = readRoute(); };
  #onTokenChange = () => { void this.#check(); };

  async #check() {
    this.checking = true;
    if (!getToken()) { this.authed = false; this.checking = false; return; }
    try {
      // Cheap probe: list waitlist (or any admin endpoint).
      await api('/admin/waitlist?limit=1');
      this.authed = true;
    } catch {
      this.authed = false;
      setToken('');
    } finally {
      this.checking = false;
    }
  }

  #signOut = () => {
    setToken('');
    window.dispatchEvent(new Event('cc-token'));
  };

  render() {
    if (this.checking) return html`<p class="msg checking">Checking token…</p>`;
    if (!this.authed) return html`<cc-token-prompt></cc-token-prompt>`;
    return html`
      <div class="shell">
        <header class="topbar">
          <h1>OpenAI Service — Admin</h1>
          <nav>
            ${ROUTES.map(
              (r) => html`<a href="#/${r}" class=${r === this.route ? 'active' : ''}>${pretty(r)}</a>`,
            )}
          </nav>
          <button class="ghost" @click=${this.#signOut}>Sign out</button>
        </header>
        <main>
          ${this.route === 'waitlist'
            ? html`<cc-waitlist-queue></cc-waitlist-queue>`
            : this.route === 'users'
            ? html`<cc-users></cc-users>`
            : this.route === 'usage'
            ? html`<cc-usage></cc-usage>`
            : this.route === 'health'
            ? html`<cc-network-health></cc-network-health>`
            : html`<cc-registry></cc-registry>`}
        </main>
      </div>
    `;
  }
}

function readRoute() {
  const h = window.location.hash.replace(/^#\//, '');
  return ROUTES.includes(h) ? h : 'waitlist';
}

function pretty(r) { return r === 'health' ? 'Health' : r[0].toUpperCase() + r.slice(1); }

customElements.define('cc-app', CcApp);
