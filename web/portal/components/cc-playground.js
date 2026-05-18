import { LitElement, html } from 'lit';
import { api } from '/lib/api.js';

const CAPABILITY_BY_TAB = {
  chat: 'openai:chat-completions',
  embeddings: 'openai:embeddings',
  rerank: 'rerank',
  images: 'openai:images-generations',
  speech: 'openai:audio-speech',
  transcriptions: 'openai:audio-transcriptions',
};

const TAB_LABEL = {
  chat: 'Chat',
  embeddings: 'Embeddings',
  rerank: 'Rerank',
  images: 'Images',
  speech: 'Speech',
  transcriptions: 'Transcribe',
};

const TABS = ['chat', 'embeddings', 'rerank', 'images', 'speech', 'transcriptions'];
const STORAGE_KEY = 'openai_service_playground_api_key';
const CHAT_SETTINGS_KEY = 'openai_service_playground_chat_settings';
const CHAT_HISTORY_KEY = 'openai_service_playground_chat_history';

class CcPlayground extends LitElement {
  static properties = {
    catalog: { state: true },
    apiKey: { state: true },
    activeTab: { state: true },
    error: { state: true },
    busy: { state: true },
    chatInput: { state: true },
    chatMessages: { state: true },
    chatSettings: { state: true },
    chatSettingsOpen: { state: true },
    chatHistoryOpen: { state: true },
    chatHistory: { state: true },
    chatResult: { state: true },
    embeddingsResult: { state: true },
    rerankResult: { state: true },
    imageResult: { state: true },
    speechResultUrl: { state: true },
    speechModel: { state: true },
    speechVoice: { state: true },
    transcriptionResult: { state: true },
  };

  constructor() {
    super();
    this.catalog = [];
    this.apiKey = sessionStorage.getItem(STORAGE_KEY) ?? '';
    this.activeTab = 'chat';
    this.error = '';
    this.busy = '';
    this.chatInput = 'Say hello in one sentence.';
    this.chatMessages = [];
    this.chatSettings = loadChatSettings();
    this.chatSettingsOpen = false;
    this.chatHistoryOpen = false;
    this.chatHistory = loadChatHistory();
    this.chatResult = '';
    this.embeddingsResult = null;
    this.rerankResult = '';
    this.imageResult = '';
    this.speechResultUrl = '';
    this.speechModel = '';
    this.speechVoice = '';
    this.transcriptionResult = '';
  }

  createRenderRoot() { return this; }

  async connectedCallback() {
    super.connectedCallback();
    try {
      const data = await api('/portal/playground/catalog');
      this.catalog = data?.data ?? [];
      this.#syncSpeechDefaults();
      this.#ensureActiveTab();
    } catch (err) {
      this.error = err.message;
    }
  }

  render() {
    return html`
      <div class="card">
        <h2>Playground</h2>
        <p class="msg">
          Uses the real local gateway <code>/v1/*</code> surface. Tabs are enabled only when
          the current selector can actually route at least one model for that capability.
        </p>
        <div class="stack-sm">
          <label>
            <div class="msg">API key</div>
            <input
              type="password"
              .value=${this.apiKey}
              @input=${(ev) => this.#setApiKey(ev.target.value)}
              placeholder="sk-..."
            >
          </label>
          <p class="msg compact">Stored in this browser tab only for local dev.</p>
        </div>
        ${this.error ? html`<p class="msg error">${this.error}</p>` : ''}
      </div>

      <div class="card">
        <div class="play-tabs" role="tablist" aria-label="Playground features">
          ${TABS.map((tab) => html`
            <button
              class="play-tab ${this.activeTab === tab ? 'play-tab--active' : ''}"
              role="tab"
              aria-selected=${this.activeTab === tab}
              tabindex=${this.activeTab === tab ? '0' : '-1'}
              ?disabled=${this.#tabDisabled(tab)}
              @click=${() => this.#setTab(tab)}
            >${this.#tabLabel(tab)}</button>
          `)}
        </div>
      </div>

      <div class="card">
        ${this.activeTab === 'chat' ? this.#renderChat() : ''}
        ${this.activeTab === 'embeddings' ? this.#renderEmbeddings() : ''}
        ${this.activeTab === 'rerank' ? this.#renderRerank() : ''}
        ${this.activeTab === 'images' ? this.#renderImages() : ''}
        ${this.activeTab === 'speech' ? this.#renderSpeech() : ''}
        ${this.activeTab === 'transcriptions' ? this.#renderTranscriptions() : ''}
      </div>
    `;
  }

  #renderChat() {
    const models = this.#modelsFor('chat');
    const selected = models[0]?.id ?? '';
    return html`
      <h2>Chat completions</h2>
      ${this.#renderUnavailableMessage('chat')}
      ${models.length === 0 ? '' : html`
        <div class="actions">
          <button class="ghost" type="button" @click=${() => { this.chatHistoryOpen = !this.chatHistoryOpen; }}>
            ${this.chatHistoryOpen ? 'Hide history' : 'History'}
          </button>
          <button class="ghost" type="button" @click=${() => { this.chatSettingsOpen = !this.chatSettingsOpen; }}>
            ${this.chatSettingsOpen ? 'Hide settings' : 'Settings'}
          </button>
          <button class="ghost" type="button" @click=${this.#clearChat}>Clear</button>
        </div>
        ${this.chatHistoryOpen ? this.#renderChatHistory() : ''}
        ${this.chatSettingsOpen ? this.#renderChatSettings() : ''}
        <form class="stack-sm" @submit=${this.#runChat}>
          ${this.#modelSelect('chatModel', models)}
          <label>
            <div class="msg">Prompt</div>
            <textarea name="prompt" rows="5" .value=${this.chatInput} @input=${(ev) => { this.chatInput = ev.target.value; }}></textarea>
          </label>
          <button class="primary" type="submit" ?disabled=${this.busy === 'chat' || !selected}>
            ${this.busy === 'chat' ? 'Running…' : 'Run chat'}
          </button>
        </form>
      `}
      ${this.chatMessages.length > 0 ? this.#renderChatMessages() : ''}
      ${this.chatResult ? html`<pre class="output">${this.chatResult}</pre>` : ''}
    `;
  }

  #renderChatMessages() {
    return html`
      <div class="chat-log" role="log" aria-live="polite">
        ${this.chatMessages.map((message) => html`
          <div class="chat-msg chat-msg--${message.role}">
            <span class="chat-role">${message.role === 'user' ? 'You' : 'AI'}</span>
            <div class="chat-body">${message.content}</div>
          </div>
        `)}
      </div>
    `;
  }

  #renderChatSettings() {
    return html`
      <div class="settings-panel stack-sm">
        <label>
          <div class="msg">System message</div>
          <textarea rows="3" .value=${this.chatSettings.system} @input=${(ev) => this.#updateChatSetting('system', ev.target.value)}></textarea>
        </label>
        <div class="settings-grid">
          <label>
            <div class="msg">Temperature</div>
            <input type="number" min="0" max="2" step="0.1" .value=${String(this.chatSettings.temperature)} @input=${(ev) => this.#updateChatSetting('temperature', ev.target.value)} />
          </label>
          <label>
            <div class="msg">Top P</div>
            <input type="number" min="0" max="1" step="0.05" .value=${String(this.chatSettings.topP)} @input=${(ev) => this.#updateChatSetting('topP', ev.target.value)} />
          </label>
          <label>
            <div class="msg">Max tokens</div>
            <input type="number" min="1" step="1" .value=${String(this.chatSettings.maxTokens)} @input=${(ev) => this.#updateChatSetting('maxTokens', ev.target.value)} />
          </label>
        </div>
      </div>
    `;
  }

  #renderChatHistory() {
    return html`
      <div class="history-panel">
        ${this.chatHistory.length === 0
          ? html`<p class="msg">No saved conversations yet.</p>`
          : html`
              ${this.chatHistory.map((entry) => html`
                <div class="history-row">
                  <button class="history-load" type="button" @click=${() => this.#loadHistory(entry.id)}>
                    <strong>${entry.title}</strong>
                    <span class="msg compact">${new Date(entry.updatedAt).toLocaleString()}</span>
                  </button>
                  <button class="ghost danger" type="button" @click=${() => this.#deleteHistory(entry.id)}>Delete</button>
                </div>
              `)}
            `}
      </div>
    `;
  }

  #renderEmbeddings() {
    const models = this.#modelsFor('embeddings');
    return html`
      <h2>Embeddings</h2>
      ${this.#renderUnavailableMessage('embeddings')}
      ${models.length === 0 ? '' : html`
        <form class="stack-sm" @submit=${this.#runEmbeddings}>
          ${this.#modelSelect('embeddingsModel', models)}
          <label>
            <div class="msg">Input</div>
            <textarea name="input" rows="5">hello world</textarea>
          </label>
          <div class="actions">
            <button class="primary" type="submit" ?disabled=${this.busy === 'embeddings'}>
              ${this.busy === 'embeddings' ? 'Generating…' : 'Generate embedding'}
            </button>
            <button class="ghost" type="button" @click=${this.#clearEmbeddings}>Clear</button>
          </div>
        </form>
      `}
      ${this.embeddingsResult ? this.#renderEmbeddingResult() : ''}
    `;
  }

  #renderEmbeddingResult() {
    const result = this.embeddingsResult;
    const preview = result.vector.slice(0, 20);
    return html`
      <div class="embed-stats">
        <div class="embed-stat">
          <span class="msg">Dimensions</span>
          <strong>${result.dimensions}</strong>
        </div>
        <div class="embed-stat">
          <span class="msg">Model</span>
          <strong>${result.model}</strong>
        </div>
        <div class="embed-stat">
          <span class="msg">Tokens</span>
          <strong>${result.tokens}</strong>
        </div>
      </div>
      <pre class="output">[${preview.map((value) => Number(value).toFixed(6)).join(', ')}${result.dimensions > 20 ? ', ...' : ''}]</pre>
      <div class="actions">
        <button class="ghost" type="button" @click=${this.#copyEmbeddingVector}>Copy vector</button>
      </div>
    `;
  }

  #renderRerank() {
    const models = this.#modelsFor('rerank');
    return html`
      <h2>Rerank</h2>
      ${this.#renderUnavailableMessage('rerank')}
      ${models.length === 0 ? '' : html`
        <form class="stack-sm" @submit=${this.#runRerank}>
          ${this.#modelSelect('rerankModel', models)}
          <label>
            <div class="msg">Query</div>
            <textarea name="query" rows="3">best local embeddings model</textarea>
          </label>
          <label>
            <div class="msg">Documents</div>
            <textarea name="documents" rows="6">nomic-embed-text-v2-moe:latest
nomic-embed-text:latest
qwen3-embedding:latest</textarea>
          </label>
          <button class="primary" type="submit" ?disabled=${this.busy === 'rerank'}>
            ${this.busy === 'rerank' ? 'Running…' : 'Run rerank'}
          </button>
        </form>
      `}
      ${this.rerankResult ? html`<pre class="output">${this.rerankResult}</pre>` : ''}
    `;
  }

  #renderImages() {
    const models = this.#modelsFor('images');
    return html`
      <h2>Image generation</h2>
      ${this.#renderUnavailableMessage('images')}
      ${models.length === 0 ? '' : html`
        <form class="stack-sm" @submit=${this.#runImages}>
          ${this.#modelSelect('imagesModel', models)}
          <label>
            <div class="msg">Prompt</div>
            <textarea name="prompt" rows="4">A watercolor fox under moonlight.</textarea>
          </label>
          <button class="primary" type="submit" ?disabled=${this.busy === 'images'}>
            ${this.busy === 'images' ? 'Running…' : 'Run image generation'}
          </button>
        </form>
      `}
      ${this.imageResult ? html`<pre class="output">${this.imageResult}</pre>` : ''}
    `;
  }

  #renderSpeech() {
    const models = this.#modelsFor('speech');
    const selectedModel = this.#selectedSpeechModel(models);
    return html`
      <h2>Audio speech</h2>
      ${this.#renderUnavailableMessage('speech')}
      ${models.length === 0 ? '' : html`
        <form class="stack-sm" @submit=${this.#runSpeech}>
          <label>
            <div class="msg">Model</div>
            <select name="speechModel" .value=${selectedModel} @change=${this.#onSpeechModelChange}>
              ${models.map((row) => html`
                <option value=${row.id}>${row.id}${row.provider ? ` — ${row.provider}` : ''}</option>
              `)}
            </select>
          </label>
          ${this.#renderSpeechVoicePicker(models)}
          <label>
            <div class="msg">Input</div>
            <textarea name="input" rows="4">Hello from the local playground.</textarea>
          </label>
          <button class="primary" type="submit" ?disabled=${this.busy === 'speech'}>
            ${this.busy === 'speech' ? 'Running…' : 'Run text-to-speech'}
          </button>
        </form>
      `}
      ${this.speechResultUrl ? html`<audio controls src=${this.speechResultUrl}></audio>` : ''}
    `;
  }

  #renderSpeechVoicePicker(models) {
    const voices = this.#currentSpeechVoices(models);
    if (!voices || (!voices.aliases && !voices.native)) {
      return html`
        <label>
          <div class="msg">Voice</div>
          <input
            class="speech-voice-input"
            name="speechVoice"
            type="text"
            placeholder="voice (model didn't publish a list)"
            .value=${this.speechVoice}
            @input=${(event) => { this.speechVoice = event.target.value; }}
          >
        </label>
      `;
    }

    const aliasEntries = Object.entries(voices.aliases ?? {});
    const nativeVoices = Array.isArray(voices.native) ? voices.native : [];
    return html`
      <label>
        <div class="msg">Voice</div>
        <select
          class="speech-voice-input"
          name="speechVoice"
          .value=${this.speechVoice}
          @change=${(event) => { this.speechVoice = event.target.value; }}
        >
          ${aliasEntries.length
            ? html`
                <optgroup label="OpenAI voices">
                  ${aliasEntries.map(([alias, native]) => html`
                    <option value=${alias}>${alias} (${native})</option>
                  `)}
                </optgroup>
              `
            : ''}
          ${nativeVoices.length
            ? html`
                <optgroup label="Native voices">
                  ${nativeVoices.map((voice) => html`<option value=${voice}>${voice}</option>`)}
                </optgroup>
              `
            : ''}
        </select>
      </label>
    `;
  }

  #renderTranscriptions() {
    const models = this.#modelsFor('transcriptions');
    return html`
      <h2>Audio transcriptions</h2>
      ${this.#renderUnavailableMessage('transcriptions')}
      ${models.length === 0 ? '' : html`
        <form class="stack-sm" @submit=${this.#runTranscription}>
          ${this.#modelSelect('transcriptionModel', models)}
          <label>
            <div class="msg">Audio file</div>
            <input name="file" type="file" accept="audio/*">
          </label>
          <button class="primary" type="submit" ?disabled=${this.busy === 'transcriptions'}>
            ${this.busy === 'transcriptions' ? 'Running…' : 'Run transcription'}
          </button>
        </form>
      `}
      ${this.transcriptionResult ? html`<pre class="output">${this.transcriptionResult}</pre>` : ''}
    `;
  }

  #renderUnavailableMessage(tab) {
    const unavailable = this.#unavailableModelsFor(tab);
    if (unavailable.length === 0) return '';
    return html`
      <p class="msg warn">
        ${unavailable.length} cached model${unavailable.length === 1 ? '' : 's'} for this capability
        are currently not selectable by the live route selector.
      </p>
    `;
  }

  #modelsFor(tab) {
    const capability = CAPABILITY_BY_TAB[tab];
    return this.catalog.filter((row) => row.capability === capability && row.selectable);
  }

  #unavailableModelsFor(tab) {
    const capability = CAPABILITY_BY_TAB[tab];
    return this.catalog.filter((row) => row.capability === capability && !row.selectable);
  }

  #tabDisabled(tab) {
    return this.#modelsFor(tab).length === 0;
  }

  #tabLabel(tab) {
    const label = TAB_LABEL[tab];
    if (!this.#tabDisabled(tab)) return label;
    const capability = CAPABILITY_BY_TAB[tab];
    const hasCached = this.catalog.some((row) => row.capability === capability);
    return hasCached ? `${label} (unavailable)` : `${label} (disabled)`;
  }

  #ensureActiveTab() {
    if (!this.#tabDisabled(this.activeTab)) return;
    const next = TABS.find((tab) => !this.#tabDisabled(tab));
    this.activeTab = next ?? 'chat';
  }

  #setTab(tab) {
    if (this.#tabDisabled(tab)) return;
    this.activeTab = tab;
    this.error = '';
  }

  #modelSelect(name, models) {
    return html`
      <label>
        <div class="msg">Model</div>
        <select name=${name}>
          ${models.map((row) => html`
            <option value=${row.id}>${row.id}${row.provider ? ` — ${row.provider}` : ''}</option>
          `)}
        </select>
      </label>
    `;
  }

  #setApiKey(value) {
    this.apiKey = value;
    sessionStorage.setItem(STORAGE_KEY, value);
  }

  #selectedSpeechModel(models) {
    if (this.speechModel && models.some((row) => row.id === this.speechModel)) return this.speechModel;
    return models[0]?.id ?? '';
  }

  #currentSpeechVoices(models) {
    const selectedModel = this.#selectedSpeechModel(models);
    const model = models.find((row) => row.id === selectedModel);
    return model?.voices ?? null;
  }

  #onSpeechModelChange = (event) => {
    this.speechModel = event.target.value;
    const voices = this.#currentSpeechVoices(this.#modelsFor('speech'));
    this.speechVoice = voices?.default ?? '';
  };

  #syncSpeechDefaults() {
    const models = this.#modelsFor('speech');
    const selectedModel = this.#selectedSpeechModel(models);
    this.speechModel = selectedModel;
    const voices = this.#currentSpeechVoices(models);
    if (!this.speechVoice || (voices?.default && !this.#speechVoiceMatches(voices, this.speechVoice))) {
      this.speechVoice = voices?.default ?? '';
    }
  }

  #speechVoiceMatches(voices, value) {
    if (!value) return false;
    const aliases = Object.keys(voices?.aliases ?? {});
    const nativeVoices = Array.isArray(voices?.native) ? voices.native : [];
    return aliases.includes(value) || nativeVoices.includes(value);
  }

  async #runChat(ev) {
    ev.preventDefault();
    const fd = new FormData(ev.currentTarget);
    const model = String(fd.get('chatModel') ?? '');
    const prompt = String(fd.get('prompt') ?? '').trim();
    if (!prompt) return;
    const messages = [];
    if (this.chatSettings.system.trim()) {
      messages.push({ role: 'system', content: this.chatSettings.system.trim() });
    }
    messages.push({ role: 'user', content: prompt });
    const data = await this.#requestJson('chat', '/v1/chat/completions', {
      model,
      messages,
      temperature: Number(this.chatSettings.temperature),
      top_p: Number(this.chatSettings.topP),
      max_tokens: Number(this.chatSettings.maxTokens),
    });
    if (!data) {
      this.chatResult = '';
      return;
    }
    const content =
      data.choices?.[0]?.message?.content ??
      data.choices?.[0]?.message?.reasoning_content ??
      '';
    this.chatMessages = [
      { role: 'user', content: prompt },
      { role: 'assistant', content: String(content) },
    ];
    this.chatResult = JSON.stringify(data, null, 2);
    this.#saveHistory({
      id: crypto.randomUUID(),
      model,
      title: prompt.slice(0, 72),
      system: this.chatSettings.system,
      messages: this.chatMessages,
      updatedAt: Date.now(),
    });
  }

  async #runEmbeddings(ev) {
    ev.preventDefault();
    const fd = new FormData(ev.currentTarget);
    const data = await this.#requestJson('embeddings', '/v1/embeddings', {
      model: String(fd.get('embeddingsModel') ?? ''),
      input: String(fd.get('input') ?? ''),
    });
    if (!data) {
      this.embeddingsResult = null;
      return;
    }
    const vector = data.data?.[0]?.embedding ?? [];
    this.embeddingsResult = {
      vector,
      dimensions: vector.length,
      model: data.model ?? String(fd.get('embeddingsModel') ?? ''),
      tokens: data.usage?.total_tokens ?? data.usage?.prompt_tokens ?? 0,
    };
  }

  #clearEmbeddings = () => {
    this.embeddingsResult = null;
    this.error = '';
  };

  async #runRerank(ev) {
    ev.preventDefault();
    const fd = new FormData(ev.currentTarget);
    const data = await this.#requestJson('rerank', '/v1/rerank', {
      model: String(fd.get('rerankModel') ?? ''),
      query: String(fd.get('query') ?? ''),
      documents: String(fd.get('documents') ?? '')
        .split('\n')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    });
    this.rerankResult = data ? JSON.stringify(data, null, 2) : '';
  }

  async #runImages(ev) {
    ev.preventDefault();
    const fd = new FormData(ev.currentTarget);
    const data = await this.#requestJson('images', '/v1/images/generations', {
      model: String(fd.get('imagesModel') ?? ''),
      prompt: String(fd.get('prompt') ?? ''),
    });
    this.imageResult = data ? JSON.stringify(data, null, 2) : '';
  }

  async #runSpeech(ev) {
    ev.preventDefault();
    const fd = new FormData(ev.currentTarget);
    this.speechResultUrl = '';
    this.error = '';
    if (!this.apiKey.trim()) {
      this.error = 'API key required';
      return;
    }
    this.busy = 'speech';
    try {
      const res = await fetch('/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: String(fd.get('speechModel') ?? this.speechModel ?? ''),
          input: String(fd.get('input') ?? ''),
          voice: String(fd.get('speechVoice') ?? this.speechVoice ?? ''),
        }),
      });
      if (!res.ok) throw await responseError(res);
      const blob = await res.blob();
      this.speechResultUrl = URL.createObjectURL(blob);
    } catch (err) {
      this.error = err.message;
    } finally {
      this.busy = '';
    }
  }

  async #runTranscription(ev) {
    ev.preventDefault();
    const fd = new FormData(ev.currentTarget);
    const file = fd.get('file');
    this.transcriptionResult = '';
    this.error = '';
    if (!this.apiKey.trim()) {
      this.error = 'API key required';
      return;
    }
    if (!(file instanceof File) || file.size === 0) {
      this.error = 'Audio file required';
      return;
    }
    this.busy = 'transcriptions';
    try {
      const body = new FormData();
      body.set('model', String(fd.get('transcriptionModel') ?? ''));
      body.set('file', file);
      const res = await fetch('/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey.trim()}` },
        body,
      });
      if (!res.ok) throw await responseError(res);
      const data = await res.json();
      this.transcriptionResult = JSON.stringify(data, null, 2);
    } catch (err) {
      this.error = err.message;
    } finally {
      this.busy = '';
    }
  }

  async #requestJson(kind, path, body) {
    this.error = '';
    if (!this.apiKey.trim()) {
      this.error = 'API key required';
      return null;
    }
    this.busy = kind;
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await responseError(res);
      return await res.json();
    } catch (err) {
      this.error = err.message;
      return null;
    } finally {
      this.busy = '';
    }
  }

  #copyEmbeddingVector = async () => {
    if (!this.embeddingsResult?.vector) return;
    await navigator.clipboard.writeText(JSON.stringify(this.embeddingsResult.vector));
  };

  #clearChat = () => {
    this.chatMessages = [];
    this.chatResult = '';
    this.error = '';
  };

  #updateChatSetting(key, value) {
    const next = {
      ...this.chatSettings,
      [key]: key === 'system' ? value : Number(value || 0),
    };
    this.chatSettings = next;
    sessionStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(next));
  }

  #saveHistory(entry) {
    const next = [entry, ...this.chatHistory.filter((row) => row.id !== entry.id)].slice(0, 25);
    this.chatHistory = next;
    localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(next));
  }

  #loadHistory(id) {
    const entry = this.chatHistory.find((row) => row.id === id);
    if (!entry) return;
    this.chatMessages = entry.messages ?? [];
    this.chatSettings = {
      ...this.chatSettings,
      system: entry.system ?? '',
    };
    this.chatSettingsOpen = false;
    this.chatHistoryOpen = false;
    sessionStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(this.chatSettings));
  }

  #deleteHistory(id) {
    const next = this.chatHistory.filter((row) => row.id !== id);
    this.chatHistory = next;
    localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(next));
  }
}

function loadChatSettings() {
  try {
    const raw = sessionStorage.getItem(CHAT_SETTINGS_KEY);
    if (!raw) {
      return { system: '', temperature: 1, topP: 1, maxTokens: 512 };
    }
    return { system: '', temperature: 1, topP: 1, maxTokens: 512, ...JSON.parse(raw) };
  } catch {
    return { system: '', temperature: 1, topP: 1, maxTokens: 512 };
  }
}

function loadChatHistory() {
  try {
    const raw = localStorage.getItem(CHAT_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function responseError(res) {
  let payload = null;
  try { payload = await res.json(); } catch {}
  const message = payload?.error?.message ?? payload?.error ?? `HTTP ${res.status}`;
  return new Error(typeof message === 'string' ? message : 'request failed');
}

customElements.define('cc-playground', CcPlayground);
