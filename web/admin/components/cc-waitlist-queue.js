import { LitElement, html } from 'lit';
import { api } from '/admin/static/lib/api.js';

class CcWaitlistQueue extends LitElement {
  static properties = {
    status: { state: true },
    rows: { state: true },
    error: { state: true },
    busyId: { state: true },
    approvalResult: { state: true },
  };

  constructor() {
    super();
    this.status = 'pending';
    this.rows = [];
    this.error = '';
    this.busyId = null;
    this.approvalResult = null;
  }

  createRenderRoot() { return this; }

  async connectedCallback() {
    super.connectedCallback();
    await this.#load();
  }

  async #load() {
    try {
      const data = await api(`/admin/waitlist?status=${this.status}&limit=200`);
      this.rows = data?.data ?? [];
    } catch (err) {
      this.error = err.message;
    }
  }

  #setStatus = async (s) => {
    this.status = s;
    await this.#load();
  };

  #act = async (id, action) => {
    this.busyId = id;
    this.error = '';
    if (action === 'approve') this.approvalResult = null;
    try {
      const result = await api(`/admin/waitlist/${id}/${action}`, { method: 'POST' });
      if (action === 'approve') this.approvalResult = result;
      await this.#load();
    } catch (err) {
      this.error = err.message;
    } finally {
      this.busyId = null;
    }
  };

  render() {
    return html`
      <div class="card">
        <h2>Waitlist</h2>
        <p class="msg">
          Review inbound signups, confirm verification state, and decide whether an
          account should be approved for API access. Approval mints an API key and
          returns the one-time plaintext key here so operations can still proceed if
          email delivery is disabled or fails.
        </p>
        <div class="filter-bar">
          ${['pending', 'approved', 'rejected'].map(
            (s) => html`<button
              class="${s === this.status ? 'primary' : 'ghost'}"
              @click=${() => this.#setStatus(s)}
            >${s}</button>`,
          )}
        </div>
        ${this.error ? html`<p class="msg error">${this.error}</p>` : ''}
        ${this.approvalResult
          ? html`<div class="card">
              <h3>Latest approved key</h3>
              <p class="msg">${this.approvalResult.emailDelivery.message}</p>
              <p><strong>Copy now.</strong> This plaintext key is not recoverable later.</p>
              <pre>${this.approvalResult.apiKey.plaintextKey}</pre>
            </div>`
          : ''}
        ${this.rows.length === 0
          ? html`<p class="msg">No ${this.status} rows.</p>`
          : html`<table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Verified</th>
                  <th>Created</th>
                  <th>Approved</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${this.rows.map((r) => html`<tr>
                  <td>${r.name}</td>
                  <td>${r.email}</td>
                  <td>${r.emailVerifiedAt
                    ? html`<span class="pill ok">verified</span>`
                    : html`<span class="pill warn">unverified</span>`}</td>
                  <td>${new Date(r.createdAt).toLocaleString()}</td>
                  <td>${r.approvedAt ? new Date(r.approvedAt).toLocaleString() : ''}</td>
                  <td>
                        ${this.status === 'pending'
                      ? html`
                          <button class="primary" ?disabled=${this.busyId === r.id}
                            @click=${() => this.#act(r.id, 'approve')}>Approve</button>
                          <button class="ghost danger" ?disabled=${this.busyId === r.id}
                            @click=${() => this.#act(r.id, 'reject')}>Reject</button>
                          ${!r.emailVerifiedAt
                            ? html`<button class="ghost warn" ?disabled=${this.busyId === r.id}
                                @click=${() => this.#act(r.id, 'resend-verification')}>Resend</button>`
                            : ''}
                        `
                      : ''}
                  </td>
                </tr>`)}
              </tbody>
            </table>`}
      </div>
    `;
  }
}

customElements.define('cc-waitlist-queue', CcWaitlistQueue);
