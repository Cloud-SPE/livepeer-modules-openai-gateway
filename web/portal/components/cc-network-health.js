import { LitElement, html } from 'lit';
import { api } from '/portal/static/lib/api.js';

class CcNetworkHealth extends LitElement {
  static properties = {
    models: { state: true },
    error: { state: true },
  };

  constructor() {
    super();
    this.models = [];
    this.error = '';
  }

  createRenderRoot() { return this; }

  async connectedCallback() {
    super.connectedCallback();
    try {
      const data = await api('/portal/playground/catalog');
      this.models = data?.data ?? [];
    } catch (err) {
      this.error = err.message;
    }
  }

  render() {
    const capabilities = summarizeCapabilities(this.models);
    const sortedModels = [...this.models].sort((a, b) => {
      if (a.category !== b.category) return a.category.localeCompare(b.category);
      return a.id.localeCompare(b.id);
    });

    return html`
      <div class="card">
        <h2>Network health ${helpTip('What this means for your account right now. This view is intentionally simplified and based on the current resolver-backed catalog snapshot.')}</h2>
        <p class="msg">
          User-facing availability for the current network snapshot. This is intentionally simple:
          it shows what capabilities exist and whether each model is currently selectable.
        </p>
        ${this.error ? html`<p class="msg error">${this.error}</p>` : ''}
      </div>

      <div class="card">
        <h2>Capabilities ${helpTip('A capability is a product feature family such as chat, embeddings, speech, or transcription.')}</h2>
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
                ${cap.selectableModels} selectable ${helpTip('Selectable means at least one live route is currently available for this capability.')} ·
                ${cap.availableModels} cached ${helpTip('Cached means the model is present in the stored catalog snapshot, even if no live route is currently selectable.')}
              </p>
            </article>
          `)}
        </div>
      </div>

      <div class="card">
        <h2>Models ${helpTip('Interaction modes show how a route is served: req/resp for unary calls, stream for streaming, multipart for file uploads.')}</h2>
        <div class="health-model-list" role="list" aria-label="Model availability">
          ${sortedModels.map((model) => html`
            <article class="health-model-row" role="listitem">
              <div class="health-model-copy">
                <h3>${model.id}</h3>
                <p>${displayCapability(model.category)}</p>
                ${model.interactionModes?.length
                  ? html`<p class="msg compact">${describeModes(model.interactionModes)} · ${model.routeCount} route${model.routeCount === 1 ? '' : 's'}</p>`
                  : ''}
              </div>
              <span class="health-badge health-badge-${model.selectable ? 'up' : 'down'}">
                ${model.selectable ? 'Available' : 'Unavailable'}
              </span>
            </article>
          `)}
        </div>
      </div>
    `;
  }
}

function helpTip(text) {
  return html`<span class="help-tip" tabindex="0" title=${text} aria-label=${text}>?</span>`;
}

function describeModes(modes) {
  const labels = modes.map((mode) => {
    if (mode === 'http-stream@v0') return 'stream';
    if (mode === 'http-reqresp@v0') return 'req/resp';
    return mode;
  });
  return labels.join(', ');
}

function summarizeCapabilities(models) {
  const byCapability = new Map();
  for (const model of models) {
    const current = byCapability.get(model.capability) ?? {
      capability: model.capability,
      category: model.category,
      availableModels: 0,
      selectableModels: 0,
    };
    current.availableModels += 1;
    if (model.selectable) current.selectableModels += 1;
    byCapability.set(model.capability, current);
  }
  return [...byCapability.values()].sort((a, b) => a.category.localeCompare(b.category));
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
