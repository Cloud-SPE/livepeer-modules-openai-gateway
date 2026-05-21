import { LitElement, html } from 'lit';
import { api } from '/admin/static/lib/api.js';

class CcRegistry extends LitElement {
  static properties = {
    candidates: { state: true },
    health: { state: true },
    models: { state: true },
    summary: { state: true },
    error: { state: true },
  };

  constructor() {
    super();
    this.candidates = [];
    this.health = null;
    this.models = [];
    this.summary = null;
    this.error = '';
  }

  createRenderRoot() { return this; }

  async connectedCallback() {
    super.connectedCallback();
    await this.#load();
  }

  async #load() {
    this.error = '';
    try {
      const [c, h, m, s] = await Promise.all([
        api('/admin/registry/candidates'),
        api('/admin/registry/health'),
        api('/admin/registry/models'),
        api('/admin/registry/summary'),
      ]);
      this.candidates = c?.data ?? [];
      this.health = h ?? null;
      this.models = m?.data ?? [];
      this.summary = s ?? null;
    } catch (err) {
      this.error = err.message;
    }
  }

  render() {
    return html`
      <div class="card">
        <h2>Registry summary ${helpTip('Compares the live resolver snapshot against the cached models table used by /v1/models.')}</h2>
        ${this.summary
          ? html`
              <p class="msg">
                Live candidates ${this.summary.liveCandidates} ·
                live models ${this.summary.liveModels} ·
                cached active ${this.summary.cachedActiveModels}
              </p>
              <p class="msg">
                Cache ${this.summary.cacheFresh ? 'fresh' : 'stale'} ·
                age ${this.summary.cacheAgeMs == null ? '—' : `${Math.round(this.summary.cacheAgeMs / 1000)}s`} ·
                max ${Math.round(this.summary.maxCacheAgeMs / 1000)}s
              </p>
              <details class="diag">
                <summary>Live vs cache diff ${helpTip('Live only means present in the current resolver snapshot but not in the cached model table. Cached only means still present in the cached table but not currently live in the resolver snapshot.')}</summary>
                <div class="kv-list">
                  <div>
                    <span class="msg">live only</span>
                    <code>${this.summary.liveOnlyModelIds.length ? this.summary.liveOnlyModelIds.join(', ') : 'none'}</code>
                  </div>
                  <div>
                    <span class="msg">cached only</span>
                    <code>${this.summary.cachedOnlyModelIds.length ? this.summary.cachedOnlyModelIds.join(', ') : 'none'}</code>
                  </div>
                </div>
              </details>
            `
          : html`<p class="msg">—</p>`}
      </div>

      <div class="card">
        <h2>Live candidates ${helpTip('These rows come directly from the live resolver catalog path, not from the cached models table.')} <button class="ghost" @click=${() => this.#load()}>Refresh</button></h2>
        ${this.error ? html`<p class="msg error">${this.error}</p>` : ''}
        ${this.candidates.length === 0
          ? html`<p class="msg">No candidates from the resolver.</p>`
          : html`<table>
              <thead>
                <tr><th>Capability</th><th>Model</th><th>Mode</th><th>Broker</th><th>Price</th><th>Quote</th></tr>
              </thead>
              <tbody>
                ${this.candidates.map(
                  (c) => html`<tr>
                    <td>
                      <code>${c.capability}</code>
                      <div class="msg compact">${c.workUnit}</div>
                    </td>
                    <td>
                      <code>${c.model ?? c.offering}</code>
                      <div class="msg compact">${c.offering}</div>
                    </td>
                    <td>${c.interactionMode ?? html`<span class="msg">—</span>`}</td>
                    <td>
                      <div><code>${shrink(c.brokerUrl)}</code></div>
                      <div class="msg compact"><code>${shrink(c.ethAddress)}</code></div>
                    </td>
                    <td>
                      <div><code>${c.pricePerWorkUnitWei}</code></div>
                      <div class="msg compact">${c.unitsPerPrice} units / price</div>
                    </td>
                    <td>
                      <details class="diag">
                        <summary><code>${c.quoteId}</code></summary>
                        <div class="kv-list">
                          <div><span class="msg">version</span><code>${c.quoteVersion}</code></div>
                          <div><span class="msg">constraint fp</span><code>${shrink(c.constraintFingerprintHex)}</code></div>
                          <div><span class="msg">route fp</span><code>${shrink(c.routeFingerprintHex)}</code></div>
                        </div>
                      </details>
                    </td>
                  </tr>`,
                )}
              </tbody>
            </table>`}
      </div>

      <div class="card">
        <h2>Route health ${helpTip('In-memory failure and cooldown tracking for candidate routes. This is process-local state and resets on restart.')}</h2>
        ${this.health
          ? html`
              <p class="msg">
                Attempts ${this.health.metrics.attemptsTotal} ·
                successes ${this.health.metrics.successesTotal} ·
                retryable ${this.health.metrics.retryableFailuresTotal} ·
                non-retryable ${this.health.metrics.nonRetryableFailuresTotal} ·
                cooldowns ${this.health.metrics.cooldownsOpenedTotal}
              </p>
              <details><summary>${this.health.snapshots.length} route snapshots</summary>
                <pre>${JSON.stringify(this.health.snapshots, null, 2)}</pre>
              </details>
            `
          : html`<p class="msg">—</p>`}
      </div>

      <div class="card">
        <h2>Models table (cached) ${helpTip('This is the persisted catalog cache used for /v1/models. It refreshes in the background from the live registry snapshot.')}</h2>
        <p class="msg">${this.models.filter((m) => m.active).length} active · ${this.models.length} total</p>
        ${this.models.length === 0
          ? html`<p class="msg">Empty.</p>`
          : html`<table>
              <thead>
                <tr><th>Model</th><th>Capability</th><th>Pricing</th><th>Quote</th><th>Active</th><th>Snapshot</th></tr>
              </thead>
              <tbody>
                ${this.models.map(
                  (m) => html`<tr>
                    <td>
                      <code>${m.modelId}</code>
                      ${m.interactionMode ? html`<div class="msg compact">${m.interactionMode}</div>` : ''}
                    </td>
                    <td><code>${m.capability}</code></td>
                    <td>
                      <div><code>${m.pricePerWorkUnitWei ?? '—'}</code></div>
                      <div class="msg compact">${m.unitsPerPrice ?? '—'} units / price</div>
                    </td>
                    <td>
                      ${m.quoteId
                        ? html`<details class="diag">
                            <summary><code>${m.quoteId}</code></summary>
                            <div class="kv-list">
                              <div><span class="msg">version</span><code>${m.quoteVersion ?? '—'}</code></div>
                              <div><span class="msg">constraint fp</span><code>${shrink(m.constraintFingerprintHex)}</code></div>
                              <div><span class="msg">route fp</span><code>${shrink(m.routeFingerprintHex)}</code></div>
                            </div>
                          </details>`
                        : html`<span class="msg">—</span>`}
                    </td>
                    <td>${m.active
                      ? html`<span class="pill ok">active</span>`
                      : html`<span class="pill bad">inactive</span>`}</td>
                    <td>${new Date(m.snapshotAt).toLocaleString()}</td>
                  </tr>`,
                )}
              </tbody>
            </table>`}
      </div>
    `;
  }
}

function shrink(value) {
  if (!value) return '—';
  return value.length > 42 ? `${value.slice(0, 18)}…${value.slice(-12)}` : value;
}

function helpTip(text) {
  return html`<span class="help-tip" tabindex="0" title=${text} aria-label=${text}>?</span>`;
}

customElements.define('cc-registry', CcRegistry);
