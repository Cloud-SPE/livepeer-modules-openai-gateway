import { LitElement, html } from 'lit';
import { api } from '/admin/static/lib/api.js';

class CcUsage extends LitElement {
  static properties = {
    rows: { state: true },
    recent: { state: true },
    error: { state: true },
  };

  constructor() { super(); this.rows = []; this.recent = []; this.error = ''; }
  createRenderRoot() { return this; }

  async connectedCallback() {
    super.connectedCallback();
    try {
      const data = await api('/admin/usage');
      this.rows = data?.data ?? [];
      this.recent = data?.recent ?? [];
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
      <div class="card">
        <h2>Paid-job reconciliation</h2>
        ${this.recent.length === 0
          ? html`<p class="msg">No requests yet.</p>`
          : html`<table>
              <thead><tr><th>When</th><th>User / model</th><th>Protocol</th><th>Identities</th><th>Units</th><th>Accounting</th></tr></thead>
              <tbody>${this.recent.map((r) => html`<tr>
                <td>${new Date(r.createdAt).toLocaleString()}</td>
                <td>${r.email}<div><code>${r.model}</code></div></td>
                <td><code>${r.jobProtocol ?? '—'}</code><div class="msg compact">${r.jobTransport ?? '—'} · ${r.selectedWorkUnit ?? '—'}</div></td>
                <td><div title="LOC request ID"><code>${shortId(r.locRequestId)}</code></div><div title="Broker job ID" class="msg compact"><code>${shortId(r.brokerJobId)}</code></div></td>
                <td>observed ${r.gatewayObservedUnits ?? '—'}<div class="msg compact">actual ${r.brokerActualUnits ?? '—'} · debited ${r.brokerDebitedUnits ?? '—'} · LOC ${r.locSettledUnits ?? '—'}</div></td>
                <td>${accountingLabel(r)}<div class="msg compact">lookup attempts ${r.settlementLookupAttempts} · settle attempts ${r.settleAttempts}</div>${r.settlementLookupLastError ? html`<div class="msg error">${r.settlementLookupLastError}</div>` : ''}</td>
              </tr>`)}</tbody>
            </table>`}
      </div>
    `;
  }
}

function shortId(value) {
  return value ? `${value.slice(0, 12)}${value.length > 12 ? '…' : ''}` : '—';
}

function accountingLabel(row) {
  if (row.settlementLookupState === 'accounting_pending') return 'accounting pending';
  if (row.terminalEvidenceType) return row.terminalEvidenceType.replaceAll('_', ' ');
  return row.settleState ?? row.settlementLookupState ?? row.state;
}

customElements.define('cc-usage', CcUsage);
