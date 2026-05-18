// Email client (Resend).
//
// Used for:
//   - Email verification (signup → click link to verify).
//   - API key delivery (admin approves → key sent by email).
//
// When RESEND_API_KEY is unset, the client is "disabled" — calls log
// "would have sent" instead of POSTing. The SaaS shell still works in
// dev; you read the verification link from the logs and click it
// yourself.

import type { FastifyBaseLogger } from 'fastify';

export interface EmailClient {
  readonly enabled: boolean;
  sendVerification(input: SendVerificationInput): Promise<void>;
  sendApiKey(input: SendApiKeyInput): Promise<void>;
}

export interface SendVerificationInput {
  email: string;
  name: string;
  token: string;
  baseUrl: string;
}

export interface SendApiKeyInput {
  email: string;
  name: string;
  plaintextKey: string;
  portalUrl: string;
}

export interface CreateEmailClientInput {
  apiKey: string | undefined;
  fromEmail: string;
  log: FastifyBaseLogger | Console;
  /** Override the Resend endpoint for tests. */
  baseUrl?: string;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function createEmailClient(input: CreateEmailClientInput): EmailClient {
  const enabled = !!input.apiKey;
  const endpoint = input.baseUrl ?? RESEND_ENDPOINT;
  const fromEmail = input.fromEmail;
  const log = input.log;

  async function send(payload: {
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<void> {
    if (!enabled) {
      log.warn(
        { to: payload.to, subject: payload.subject, preview: payload.text.slice(0, 200) },
        'email disabled (RESEND_API_KEY unset) — would have sent',
      );
      return;
    }
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey!}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
      }),
    });
    if (!resp.ok) {
      const body = await safeReadText(resp);
      throw new Error(
        `Resend send failed: ${resp.status} ${resp.statusText}: ${body}`,
      );
    }
  }

  return {
    enabled,
    async sendVerification({ email, name, token, baseUrl }): Promise<void> {
      // Point at the site SPA's /verify page — it calls /api/verify on
      // the gateway and renders a friendly result.
      const link = `${trimTrailingSlash(baseUrl)}/verify.html?token=${encodeURIComponent(token)}`;
      await send({
        to: email,
        subject: 'Verify your OpenAI Service signup',
        html: verificationHtml({ name, link }),
        text: verificationText({ name, link }),
      });
    },
    async sendApiKey({ email, name, plaintextKey, portalUrl }): Promise<void> {
      await send({
        to: email,
        subject: 'Your OpenAI Service API key',
        html: apiKeyHtml({ name, plaintextKey, portalUrl }),
        text: apiKeyText({ name, plaintextKey, portalUrl }),
      });
    },
  };
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '<unreadable body>';
  }
}

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

// ── Templates ────────────────────────────────────────────────────────

function verificationHtml({ name, link }: { name: string; link: string }): string {
  return `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 540px; margin: 24px auto; padding: 0 16px;">
<h2>Verify your email</h2>
<p>Hi ${escapeHtml(name)},</p>
<p>Thanks for signing up for OpenAI Service. Please verify your email by clicking the link below:</p>
<p><a href="${link}" style="display: inline-block; padding: 10px 16px; background: #0a7; color: white; text-decoration: none; border-radius: 6px;">Verify email</a></p>
<p>Or paste this URL into your browser:</p>
<p style="font-family: monospace; font-size: 13px; word-break: break-all;">${link}</p>
<p>This link expires in 24 hours. After verification, an admin will review your signup and email you an API key.</p>
</body></html>`;
}

function verificationText({ name, link }: { name: string; link: string }): string {
  return `Hi ${name},

Thanks for signing up for OpenAI Service. Verify your email:

${link}

This link expires in 24 hours. After verification, an admin will review your signup and email you an API key.`;
}

function apiKeyHtml({
  name,
  plaintextKey,
  portalUrl,
}: {
  name: string;
  plaintextKey: string;
  portalUrl: string;
}): string {
  return `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 540px; margin: 24px auto; padding: 0 16px;">
<h2>Your API key is ready</h2>
<p>Hi ${escapeHtml(name)},</p>
<p>Your signup is approved. Here is your API key — copy it now; it won't be shown again:</p>
<pre style="background: #f4f4f4; padding: 12px; border-radius: 6px; font-size: 14px; user-select: all;">${plaintextKey}</pre>
<p>Use it as a drop-in OpenAI replacement:</p>
<pre style="background: #f4f4f4; padding: 12px; border-radius: 6px; font-size: 13px;">
from openai import OpenAI
client = OpenAI(api_key="${plaintextKey}", base_url="…")
</pre>
<p>Manage your keys in the <a href="${portalUrl}">portal</a>.</p>
</body></html>`;
}

function apiKeyText({
  name,
  plaintextKey,
  portalUrl,
}: {
  name: string;
  plaintextKey: string;
  portalUrl: string;
}): string {
  return `Hi ${name},

Your signup is approved. Here is your API key — copy it now; it won't be shown again:

${plaintextKey}

Use it as a drop-in OpenAI replacement (set base_url to your gateway endpoint).
Manage your keys in the portal: ${portalUrl}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
