export const Capability = {
  ChatCompletions: 'openai:chat-completions',
  Embeddings: 'openai:embeddings',
  AudioTranscriptions: 'openai:audio-transcriptions',
  AudioSpeech: 'openai:audio-speech',
  ImagesGenerations: 'openai:images-generations',
  Realtime: 'openai:realtime',
  Rerank: 'rerank',
} as const;

export type CapabilityId = (typeof Capability)[keyof typeof Capability];
