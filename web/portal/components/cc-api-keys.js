import { LitElement, html } from 'lit';
import { api } from '/lib/api.js';

class CcApiKeys extends LitElement {
  static properties = {
    keys: { state: true },
    newKeyPlaintext: { state: true },
    creating: { state: true },
    error: { state: true },
  };

  constructor() {
    super();
    this.keys = [];
    this.newKeyPlaintext = '';
    this.creating = false;
    this.error = '';
  }

  createRenderRoot() { return this; }

  async connectedCallback() {
    super.connectedCallback();
    await this.#load();
  }

  async #load() {
    try {
      const data = await api('/portal/api-keys');
      this.keys = data?.data ?? [];
    } catch (err) {
      this.error = err.message;
    }
  }

  async #create(ev) {
    ev.preventDefault();
    const fd = new FormData(ev.currentTarget);
    const label = String(fd.get('label') ?? '').trim();
    this.creating = true;
    this.error = '';
    try {
      const data = await api('/portal/api-keys', {
        method: 'POST',
        body: label ? { label } : {},
      });
      this.newKeyPlaintext = data.plaintextKey;
      ev.target.reset();
      await this.#load();
    } catch (err) {
      this.error = err.message;
    } finally {
      this.creating = false;
    }
  }

  async #revoke(id) {
    if (!confirm('Revoke this API key? Active sessions using it will also be signed out.')) return;
    try {
      await api(`/portal/api-keys/${id}`, { method: 'DELETE' });
      await this.#load();
    } catch (err) {
      this.error = err.message;
    }
  }

  render() {
    return html`
      <div class="card">
        <h2>Create a new key</h2>
        <p class="msg">
          Keys are the only credential accepted by the <code>/v1/*</code> API.
          Create separate keys for different environments or integrations so
          they can be rotated independently.
        </p>
        <form @submit=${this.#create}>
          <input name="label" type="text" placeholder="Label (optional)" maxlength="100">
          <button class="primary" type="submit" ?disabled=${this.creating}>
            ${this.creating ? 'Creating…' : 'Create key'}
          </button>
        </form>
        ${this.newKeyPlaintext
          ? html`<p class="msg ok new-key-note">Copy this now — it won't be shown again.</p>
                 <pre class="key">${this.newKeyPlaintext}</pre>`
          : ''}
        ${this.error ? html`<p class="msg error">${this.error}</p>` : ''}
      </div>

      <div class="card">
        <h2>Your keys</h2>
        <p class="msg">
          Revoking a key immediately disables API access for that key and also
          invalidates any portal sessions created from it.
        </p>
        ${this.keys.length === 0
          ? html`<p class="msg">No keys yet.</p>`
          : html`<table>
              <thead>
                <tr><th>Label</th><th>Prefix</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                ${this.keys.map(
                  (k) => html`<tr>
                    <td>${k.label ?? html`<span class="msg">(unnamed)</span>`}</td>
                    <td><code>${k.keyPrefix}…</code></td>
                    <td>${fmt(k.createdAt)}</td>
                    <td>${k.lastUsedAt ? fmt(k.lastUsedAt) : html`<span class="msg">—</span>`}</td>
                    <td>${k.revokedAt
                      ? html`<span class="pill warn">revoked</span>`
                      : html`<span class="pill ok">active</span>`}</td>
                    <td>${k.revokedAt
                      ? ''
                      : html`<button class="ghost danger" @click=${() => this.#revoke(k.id)}>Revoke</button>`}</td>
                  </tr>`,
                )}
              </tbody>
            </table>`}
      </div>
    `;
  }
}

function fmt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString();
}

customElements.define('cc-api-keys', CcApiKeys);
