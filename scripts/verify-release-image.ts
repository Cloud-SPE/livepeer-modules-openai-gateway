// Verify that a locally available gateway image is a release artifact rather
// than an unversioned development build. This performs no network calls and
// starts only an isolated metadata probe container (no ports or services).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

interface ImageInspect {
  Architecture?: string;
  Os?: string;
  Id?: string;
  Config?: {
    User?: string;
    Labels?: Record<string, string>;
    Healthcheck?: { Test?: string[] };
  };
}

const packageVersion = String(
  (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version?: unknown;
  }).version,
);
const image = process.env['RELEASE_IMAGE'] ??
  `tztcloud/openai-service-gateway:v${packageVersion}`;
const expectedVersion = process.env['RELEASE_VERSION'] ?? packageVersion;
const expectedRevision = process.env['RELEASE_REVISION'] ?? git('rev-parse', 'HEAD');
const requireImmutable = process.env['REQUIRE_IMMUTABLE_IMAGE'] === 'true';

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function pass(message: string): void {
  console.log(`✓ ${message}`);
}

function main(): void {
  if (requireImmutable && !/@sha256:[0-9a-f]{64}$/.test(image)) {
    fail('RELEASE_IMAGE must be pinned as repository@sha256:<64 hex characters>');
  }

  let inspect: ImageInspect;
  try {
    const raw = docker('image', 'inspect', image);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed[0] || typeof parsed[0] !== 'object') {
      fail('docker image inspect returned an unexpected response');
    }
    inspect = parsed[0] as ImageInspect;
  } catch (error) {
    return fail(`cannot inspect ${image}: ${errorMessage(error)}`);
  }

  const labels = inspect.Config?.Labels ?? {};
  if (labels['org.opencontainers.image.version'] !== expectedVersion) {
    fail(
      `image version ${labels['org.opencontainers.image.version'] ?? '<missing>'} ` +
        `does not match ${expectedVersion}`,
    );
  }
  const actualRevision = labels['org.opencontainers.image.revision'];
  if (!actualRevision || !revisionMatches(actualRevision, expectedRevision)) {
    fail(`image revision ${actualRevision ?? '<missing>'} does not match ${expectedRevision}`);
  }
  if (inspect.Os !== 'linux') fail(`image OS is ${inspect.Os ?? '<missing>'}, expected linux`);
  if (!['amd64', 'arm64'].includes(inspect.Architecture ?? '')) {
    fail(`unsupported image architecture ${inspect.Architecture ?? '<missing>'}`);
  }
  if (inspect.Config?.User !== '65532:65532') {
    fail(`image user is ${inspect.Config?.User ?? '<missing>'}, expected 65532:65532`);
  }
  if (!inspect.Config?.Healthcheck?.Test?.join(' ').includes('/health')) {
    fail('image healthcheck does not probe /health');
  }

  const probe = [
    "const fs=require('node:fs');",
    "const p=require('/app/gateway/package.json');",
    `if(p.version!==${JSON.stringify(expectedVersion)})process.exit(10);`,
    "if(!fs.existsSync('/app/gateway/migrations/0009_usage_outcome_not_refund.sql'))process.exit(11);",
    "if(p.dependencies?.['@livepeer-network/audio-duration'])process.exit(12);",
  ].join('');
  try {
    docker('run', '--rm', '--entrypoint', 'node', image, '-e', probe);
  } catch (error) {
    fail(`isolated image contents probe failed: ${errorMessage(error)}`);
  }

  pass(`${image} carries version ${expectedVersion} and revision ${actualRevision}`);
  pass(`linux/${inspect.Architecture}, non-root runtime, /health probe, migrations through 0009`);
  pass('image has no @livepeer-network/audio-duration runtime dependency');
  if (inspect.Id) pass(`local image id ${inspect.Id}`);
}

function revisionMatches(actual: string, expected: string): boolean {
  return actual === expected || actual.startsWith(expected) || expected.startsWith(actual);
}

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim();
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main();
