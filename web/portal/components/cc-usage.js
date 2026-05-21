import { LitElement, html } from 'lit';
import { api } from '/portal/static/lib/api.js';

class CcUsage extends LitElement {
  static properties = {
    rows: { state: true },
    error: { state: true },
    selectedRoute: { state: true },
  };

  constructor() {
    super();
    this.rows = [];
    this.error = '';
    this.selectedRoute = null;
  }

  createRenderRoot() { return this; }

  async connectedCallback() {
    super.connectedCallback();
    try {
      const data = await api('/portal/usage?limit=100');
      this.rows = data?.data ?? [];
    } catch (err) {
      this.error = err.message;
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.#handleKeydown);
  }

  render() {
    return html`
      <div class="card">
        <h2>Recent requests <span class="help-tip" tabindex="0" title="Each row is one proxied API request. Route details show the selected broker, operator, quote, and work-unit metadata used for that request." aria-label="Each row is one proxied API request. Route details show the selected broker, operator, quote, and work-unit metadata used for that request.">?</span></h2>
        ${this.error ? html`<p class="msg error">${this.error}</p>` : ''}
        ${this.rows.length === 0
          ? html`<p class="msg">No requests yet.</p>`
          : html`<table class="usage-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Capability</th>
                  <th>Model</th>
                  <th>Route</th>
                  <th>State</th>
                  <th>Work units</th>
                  <th>Status</th>
                  <th>Latency</th>
                </tr>
              </thead>
              <tbody>
                ${this.rows.map(
                  (r) => html`<tr>
                    <td>${new Date(r.createdAt).toLocaleString()}</td>
                    <td>
                      <div><code>${r.capability}</code></div>
                      ${r.selectedCapability && r.selectedCapability !== r.capability
                        ? html`<div class="msg compact">selected <code>${r.selectedCapability}</code></div>`
                        : ''}
                    </td>
                    <td><code>${r.model}</code></td>
                    <td class="usage-route-cell">
                      ${hasRouteDetails(r)
                        ? html`<button class="ghost usage-route-button" type="button" @click=${() => this.#openRoute(r)}>
                            ${r.selectedOffering ?? 'View route'}
                          </button>`
                        : html`<span class="msg">—</span>`}
                    </td>
                    <td><span class="pill ${r.state === 'committed' ? 'ok' : r.state === 'refunded' ? 'warn' : ''}">${r.state}</span></td>
                    <td>${r.committedWorkUnits ?? html`<span class="msg">—</span>`}</td>
                    <td>${r.statusCode ?? ''}</td>
                    <td>${r.latencyMs != null ? `${r.latencyMs}ms` : ''}</td>
                  </tr>`,
                )}
              </tbody>
            </table>`}
      </div>
      ${this.selectedRoute ? this.#renderRouteModal() : ''}
    `;
  }

  #openRoute(row) {
    this.selectedRoute = {
      offering: row.selectedOffering ?? '—',
      broker: row.brokerUrl ?? '—',
      operator: row.ethAddress ?? '—',
      quoteId: row.quoteId ?? '—',
      quoteVersion: row.quoteVersion ?? '—',
      workUnit: row.selectedWorkUnit ?? '—',
      unitsPerPrice: row.unitsPerPrice ?? '—',
      estimatedWorkUnits: row.estimatedWorkUnits ?? '—',
    };
    window.addEventListener('keydown', this.#handleKeydown);
  }

  #closeRoute = () => {
    this.selectedRoute = null;
    window.removeEventListener('keydown', this.#handleKeydown);
  };

  #handleKeydown = (event) => {
    if (event.key === 'Escape') this.#closeRoute();
  };

  #renderRouteModal() {
    const route = this.selectedRoute;
    return html`
      <div class="modal-backdrop" @click=${this.#closeRoute}>
        <div class="modal-card usage-modal" role="dialog" aria-modal="true" aria-label="Route details" @click=${(event) => event.stopPropagation()}>
          <div class="modal-header">
            <h3>Route details</h3>
            <button class="ghost" type="button" @click=${this.#closeRoute}>Close</button>
          </div>
          <div class="kv-list">
            <div><span class="msg">offering</span><code>${route.offering}</code></div>
            <div><span class="msg">broker</span><code>${route.broker}</code></div>
            <div><span class="msg">operator</span><code>${route.operator}</code></div>
            <div><span class="msg">quote</span><code>${route.quoteId}</code></div>
            <div><span class="msg">version</span><code>${route.quoteVersion}</code></div>
            <div><span class="msg">work unit</span><code>${route.workUnit}</code></div>
            <div><span class="msg">units/price</span><code>${route.unitsPerPrice}</code></div>
            <div><span class="msg">estimated</span><code>${route.estimatedWorkUnits}</code></div>
          </div>
        </div>
      </div>
    `;
  }
}

function hasRouteDetails(row) {
  return Boolean(row.quoteId || row.selectedOffering || row.brokerUrl || row.ethAddress);
}

customElements.define('cc-usage', CcUsage);
