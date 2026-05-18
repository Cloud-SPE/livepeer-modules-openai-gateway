import test from 'node:test';
import assert from 'node:assert/strict';

import { flattenResolveResult } from '../src/registry/catalog.js';

test('flattenResolveResult preserves exact resolver capability ids', () => {
  const candidates = flattenResolveResult({
    nodes: [
      {
        url: 'https://broker.example.com',
        operatorAddress: '0xabc',
        enabled: true,
        capabilities: [
          {
            name: 'openai:/v1/chat/completions',
            workUnit: 'tokens',
            offerings: [{ id: 'gpt-oss-20b', pricePerWorkUnitWei: '1000' }],
          },
          {
            name: 'openai:chat-completions',
            workUnit: 'tokens',
            extraJson: JSON.stringify({ openai: { model: 'qwen3.6-27b' } }),
            offerings: [{ id: 'vllm-qwen3.6-27b-default', pricePerWorkUnitWei: '2000' }],
          },
        ],
      },
    ],
  });

  assert.deepEqual(
    candidates.map((candidate) => ({
      capability: candidate.capability,
      offering: candidate.offering,
      model: candidate.model,
    })),
    [
      {
        capability: 'openai:/v1/chat/completions',
        offering: 'gpt-oss-20b',
        model: null,
      },
      {
        capability: 'openai:chat-completions',
        offering: 'vllm-qwen3.6-27b-default',
        model: 'qwen3.6-27b',
      },
    ],
  );
});
