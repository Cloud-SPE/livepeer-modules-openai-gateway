import { LitElement, html } from 'lit';
import { api } from '/lib/api.js';

class CcUsers extends LitElement {
  static properties = {
    rows: { state: true },
    error: { state: true },
    selectedId: { state: true },
    selected: { state: true },
  };

  constructor() {
    super();
    this.rows = [];
    this.error = '';
    this.selectedId = null;
    this.selected = null;
  }

  createRenderRoot() { return this; }

  async connectedCallback() {
    super.connectedCallback();
    await this.#load();
  }

  async #load() {
    try {
      const data = await api('/admin/users?limit=200');
      this.rows = data?.data ?? [];
    } catch (err) {
      this.error = err.message;
    }
  }

  #select = async (id) => {
    this.selectedId = id;
    this.selected = null;
    try {
      this.selected = await api(`/admin/users/${id}`);
    } catch (err) {
      this.error = err.message;
    }
  };

  render() {
    return html`
      <div class="card">
        <h2>Approved users</h2>
        <p class="msg">
          Inspect approved accounts, review which keys are active, and confirm recent
          usage before investigating more detailed request or registry diagnostics.
        </p>
        ${this.error ? html`<p class="msg error">${this.error}</p>` : ''}
        ${this.rows.length === 0
          ? html`<p class="msg">No approved users yet.</p>`
          : html`<table>
              <thead>
                <tr><th>Email</th><th>Name</th><th>Approved</th><th></th></tr>
              </thead>
              <tbody>
                ${this.rows.map(
                  (u) => html`<tr>
                    <td>${u.email}</td>
                    <td>${u.name}</td>
                    <td>${u.approvedAt ? new Date(u.approvedAt).toLocaleDateString() : ''}</td>
                    <td><button class="ghost" @click=${() => this.#select(u.id)}>Detail</button></td>
                  </tr>`,
                )}
              </tbody>
            </table>`}
      </div>
      ${this.selected
        ? html`<div class="card">
            <h2>${this.selected.name} <span class="msg">(${this.selected.email})</span></h2>
            <p class="msg">
              Status: ${this.selected.status} · Verified ${this.selected.emailVerifiedAt ? '✓' : '✗'}
            </p>
            <p class="msg">
              This view summarizes the account's current API keys and aggregate usage.
              Use the Usage and Registry tabs when you need request-level or routing-level
              detail.
            </p>
            <h3>Usage</h3>
            <p class="msg">Total ${this.selected.usage.totalRequests} · committed ${this.selected.usage.committedTotal} · refunded ${this.selected.usage.refundedTotal}</p>
            <h3>API keys</h3>
            <table>
              <thead>
                <tr><th>Label</th><th>Prefix</th><th>Created</th><th>Last used</th><th>Status</th></tr>
              </thead>
              <tbody>
                ${this.selected.apiKeys.map(
                  (k) => html`<tr>
                    <td>${k.label ?? html`<span class="msg">(unnamed)</span>`}</td>
                    <td><code>${k.keyPrefix}…</code></td>
                    <td>${new Date(k.createdAt).toLocaleDateString()}</td>
                    <td>${k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : html`<span class="msg">—</span>`}</td>
                    <td>${k.revokedAt
                      ? html`<span class="pill bad">revoked</span>`
                      : html`<span class="pill ok">active</span>`}</td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`
        : ''}
    `;
  }
}

customElements.define('cc-users', CcUsers);
