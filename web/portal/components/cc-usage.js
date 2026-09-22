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
                    <td>${renderAccountingState(r)}</td>
                    <td>${r.brokerActualUnits ?? r.committedWorkUnits ?? html`<span class="msg">—</span>`} ${r.selectedWorkUnit ?? ''}</td>
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
      protocol: row.jobProtocol ?? '—',
      transport: row.jobTransport ?? '—',
      locJobId: row.locJobId ?? '—',
      requestId: row.locRequestId ?? '—',
      paymentWorkId: row.paymentWorkId ?? '—',
      brokerJobId: row.brokerJobId ?? '—',
      lookupState: row.settlementLookupState ?? '—',
      lookupAttempts: row.settlementLookupAttempts ?? 0,
      lookupError: row.settlementLookupLastError ?? '—',
      gatewayObserved: row.gatewayObservedUnits ?? '—',
      brokerActual: row.brokerActualUnits ?? '—',
      brokerDebited: row.brokerDebitedUnits ?? '—',
      brokerOutcome: row.brokerSettlementOutcome ?? '—',
      locSettled: row.locSettledUnits ?? '—',
      locOutcome: row.locSettlementOutcome ?? '—',
      locAccounting: row.locAccountingOutcome ?? '—',
      settlementDomain: row.settlementDomainId ?? '—',
      settleState: row.settleState ?? '—',
      terminalEvidence: row.terminalEvidenceType ?? '—',
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
            <div><span class="msg">protocol / transport</span><code>${route.protocol} / ${route.transport}</code></div>
            <div><span class="msg">LOC job</span><code>${route.locJobId}</code></div>
            <div><span class="msg">request ID</span><code>${route.requestId}</code></div>
            <div><span class="msg">authorization / legacy work ID</span><code>${route.paymentWorkId}</code></div>
            <div><span class="msg">broker job</span><code>${route.brokerJobId}</code></div>
            <div><span class="msg">lookup</span><code>${route.lookupState} (${route.lookupAttempts})</code></div>
            ${route.lookupError !== '—' ? html`<div><span class="msg">lookup error</span><code>${route.lookupError}</code></div>` : ''}
            <div><span class="msg">gateway observed</span><code>${route.gatewayObserved}</code></div>
            <div><span class="msg">broker actual / debited</span><code>${route.brokerActual} / ${route.brokerDebited}</code></div>
            <div><span class="msg">broker outcome</span><code>${route.brokerOutcome}</code></div>
            <div><span class="msg">LOC settled</span><code>${route.locSettled} (${route.locOutcome})</code></div>
            <div><span class="msg">settlement</span><code>${route.settleState}</code></div>
            <div><span class="msg">LOC accounting</span><code>${route.locAccounting}</code></div>
            <div><span class="msg">settlement domain</span><code>${route.settlementDomain}</code></div>
            <div><span class="msg">terminal evidence</span><code>${route.terminalEvidence}</code></div>
          </div>
        </div>
      </div>
    `;
  }
}

function hasRouteDetails(row) {
  return Boolean(row.selectedOffering || row.brokerUrl || row.locRequestId || row.brokerJobId);
}

function renderAccountingState(row) {
  const state = row.settlementLookupState === 'accounting_pending'
    ? 'accounting pending'
    : row.settleState ?? row.settlementLookupState ?? row.state;
  const tone = state === 'settled' || state === 'ready' ? 'ok'
    : state === 'failed' || state === 'not_admitted' || state === 'evidence_expired' ? 'warn'
    : '';
  return html`<span class="pill ${tone}">${state}</span>`;
}

customElements.define('cc-usage', CcUsage);
