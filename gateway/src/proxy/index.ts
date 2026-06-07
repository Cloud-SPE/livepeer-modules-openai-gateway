// Register all /v1/* proxy routes. Each handler registers its own
// preHandler (bearerAuth), so this file is just a manifest.

import type { FastifyInstance } from 'fastify';

import type { ServerDeps } from '../server.js';
import { registerChatRoute } from './chat.js';
import { registerEmbeddingsRoute } from './embeddings.js';
import { registerImagesRoute } from './images.js';
import { registerAudioSpeechRoute } from './audio-speech.js';
import { registerAudioTranscriptionsRoute } from './audio-transcriptions.js';
import { registerRerankRoute } from './rerank.js';

export async function registerProxyRoutes(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  // Buffer multipart bodies raw — audio-transcriptions forwards the
  // multipart payload verbatim to the broker and only peeks at the
  // `model` field via extractMultipartField. Without this parser,
  // Fastify 415s multipart requests before the handler runs.
  app.addContentTypeParser(
    'multipart/form-data',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  await registerChatRoute(app, deps);
  await registerEmbeddingsRoute(app, deps);
  await registerImagesRoute(app, deps);
  await registerAudioSpeechRoute(app, deps);
  await registerAudioTranscriptionsRoute(app, deps);
  await registerRerankRoute(app, deps);
}
