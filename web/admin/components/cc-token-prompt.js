import { LitElement, html } from 'lit';
import { setToken } from '/lib/api.js';

class CcTokenPrompt extends LitElement {
  static properties = { error: { state: true } };

  constructor() { super(); this.error = ''; }
  createRenderRoot() { return this; }

  #onSubmit = (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.currentTarget);
    const token = String(fd.get('token') ?? '').trim();
    if (!token) { this.error = 'token required'; return; }
    setToken(token);
    window.dispatchEvent(new Event('cc-token'));
  };

  render() {
    return html`
      <main>
        <div class="card centered">
          <h2>Admin sign-in</h2>
          <p class="msg">
            Paste the <code>ADMIN_TOKEN</code> from the gateway environment to access
            operational workflows: waitlist review, user inspection, usage summaries,
            and registry diagnostics. The token is stored in <code>localStorage</code>
            in this browser.
          </p>
          <form class="stack-sm" @submit=${this.#onSubmit}>
            <input name="token" type="password" placeholder="ADMIN_TOKEN" autocomplete="off" required>
            <button class="primary" type="submit">Sign in</button>
          </form>
          ${this.error ? html`<p class="msg error">${this.error}</p>` : ''}
        </div>
      </main>
    `;
  }
}

customElements.define('cc-token-prompt', CcTokenPrompt);
