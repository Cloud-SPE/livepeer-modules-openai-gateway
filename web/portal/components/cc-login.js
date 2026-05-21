import { LitElement, html } from 'lit';
import { api } from '/portal/static/lib/api.js';

class CcLogin extends LitElement {
  static properties = {
    state: { state: true },
    error: { state: true },
  };

  constructor() {
    super();
    this.state = 'idle';
    this.error = '';
  }

  createRenderRoot() { return this; }

  render() {
    return html`
      <main>
        <div class="card centered">
          <h2>Sign in</h2>
          <p class="msg">
            Use an active API key from an approved account to access the portal.
            The portal gives you account visibility, key management, usage history,
            and a live playground for the current network surface.
          </p>
          <form class="stack-sm" @submit=${this.#onSubmit}>
            <input
              name="apiKey"
              type="password"
              placeholder="sk-..."
              autocomplete="current-password"
              required
            >
            <button class="primary" type="submit" ?disabled=${this.state === 'submitting'}>
              ${this.state === 'submitting' ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          ${this.error ? html`<p class="msg error">${this.error}</p>` : ''}
        </div>
      </main>
    `;
  }

  async #onSubmit(ev) {
    ev.preventDefault();
    const fd = new FormData(ev.currentTarget);
    this.state = 'submitting';
    this.error = '';
    try {
      await api('/portal/login', {
        method: 'POST',
        body: { apiKey: String(fd.get('apiKey')) },
      });
      window.dispatchEvent(new Event('cc-login'));
    } catch (err) {
      this.error = err.message;
      this.state = 'idle';
    }
  }
}

customElements.define('cc-login', CcLogin);
