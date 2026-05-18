import { LitElement, html } from 'lit';
import { api } from '/lib/api.js';

class CcUsage extends LitElement {
  static properties = {
    rows: { state: true },
    error: { state: true },
  };

  constructor() { super(); this.rows = []; this.error = ''; }
  createRenderRoot() { return this; }

  async connectedCallback() {
    super.connectedCallback();
    try {
      const data = await api('/admin/usage');
      this.rows = data?.data ?? [];
    } catch (err) {
      this.error = err.message;
    }
  }

  render() {
    return html`
      <div class="card">
        <h2>Usage by API key</h2>
        ${this.error ? html`<p class="msg error">${this.error}</p>` : ''}
        ${this.rows.length === 0
          ? html`<p class="msg">No requests yet.</p>`
          : html`<table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>API key</th>
                  <th>Total</th>
                  <th>Committed</th>
                  <th>Refunded</th>
                  <th>Last used</th>
                </tr>
              </thead>
              <tbody>
                ${this.rows.map(
                  (r) => html`<tr>
                    <td>${r.email}</td>
                    <td><code>${r.apiKeyId.slice(0, 8)}…</code></td>
                    <td>${r.totalRequests}</td>
                    <td>${r.committedTotal}</td>
                    <td>${r.refundedTotal}</td>
                    <td>${r.lastUsedAt ? new Date(r.lastUsedAt).toLocaleString() : ''}</td>
                  </tr>`,
                )}
              </tbody>
            </table>`}
      </div>
    `;
  }
}

customElements.define('cc-usage', CcUsage);
