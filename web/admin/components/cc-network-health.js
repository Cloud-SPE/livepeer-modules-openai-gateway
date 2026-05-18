import { LitElement, html } from 'lit';
import { api } from '/lib/api.js';

class CcNetworkHealth extends LitElement {
  static properties = {
    health: { state: true },
    error: { state: true },
  };

  constructor() {
    super();
    this.health = null;
    this.error = '';
  }

  createRenderRoot() { return this; }

  async connectedCallback() {
    super.connectedCallback();
    try {
      this.health = await api('/admin/registry/model-health');
    } catch (err) {
      this.error = err.message;
    }
  }

  render() {
    const capabilities = this.health?.capabilities ?? [];
    const models = this.health?.models ?? [];
    return html`
      <div class="card">
        <h2>Network health ${helpTip('Operator-facing health derived from cached models plus the current live resolver snapshot. Use Registry for raw diagnostics.')}</h2>
        <p class="msg">
          Operator-facing capability and model availability. This is the concise health view.
          Use the registry tab for raw candidates, cache diffs, and route snapshots.
        </p>
        ${this.error ? html`<p class="msg error">${this.error}</p>` : ''}
      </div>

      <div class="card">
        <h2>Capabilities ${helpTip('Available models are present in the cached model table. Selectable models have at least one live route in the current resolver snapshot.')}</h2>
        <div class="health-capability-grid">
          ${capabilities.map((cap) => html`
            <article class="health-card">
              <div class="health-card-row">
                <h3>${displayCapability(cap.category)}</h3>
                <span class="health-badge health-badge-${cap.selectableModels > 0 ? 'up' : 'down'}">
                  ${cap.selectableModels > 0 ? 'Available' : 'Unavailable'}
                </span>
              </div>
              <p class="msg">
                ${cap.selectableModels} selectable · ${cap.unavailableModels} unavailable · ${cap.availableModels} cached
              </p>
            </article>
          `)}
        </div>
      </div>

      <div class="card">
        <h2>Models ${helpTip('Modes are transport shapes published by the resolver. Offerings are resolver-facing route keys, which may differ from the user-facing model id.')}</h2>
        ${models.length === 0
          ? html`<p class="msg">No model health data.</p>`
          : html`<table>
              <thead>
                <tr><th>Model</th><th>Category</th><th>Status</th><th>Routes</th><th>Modes</th><th>Offerings</th><th>Reason</th><th>Snapshot</th></tr>
              </thead>
              <tbody>
                ${models.map((model) => html`
                  <tr>
                    <td>
                      <code>${model.id}</code>
                      ${model.provider ? html`<div class="msg compact">${model.provider}</div>` : ''}
                    </td>
                    <td>${displayCapability(model.category)}</td>
                    <td>
                      <span class="pill ${model.selectable ? 'ok' : 'bad'}">
                        ${model.selectable ? 'selectable' : 'unavailable'}
                      </span>
                    </td>
                    <td>${model.routeCount}</td>
                    <td>${model.interactionModes?.length ? model.interactionModes.join(', ') : '—'}</td>
                    <td>${model.offerings?.length ? model.offerings.join(', ') : '—'}</td>
                    <td>${model.reason ?? '—'}</td>
                    <td>${new Date(model.snapshotAt).toLocaleString()}</td>
                  </tr>
                `)}
              </tbody>
            </table>`}
      </div>
    `;
  }
}

function helpTip(text) {
  return html`<span class="help-tip" tabindex="0" title=${text} aria-label=${text}>?</span>`;
}

function displayCapability(category) {
  switch (category) {
    case 'chat': return 'Chat';
    case 'embeddings': return 'Embeddings';
    case 'images': return 'Images';
    case 'speech': return 'Speech';
    case 'transcriptions': return 'Transcribe';
    case 'rerank': return 'Rerank';
    default: return category;
  }
}

customElements.define('cc-network-health', CcNetworkHealth);
