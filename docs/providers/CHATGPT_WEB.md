---
title: "Providers — ChatGPT Web (Codex)"
version: 3.8.50
lastUpdated: 2026-08-26
---

# Providers — ChatGPT Web (Codex)

`chatgpt-web-codex` (alias `cgpt-codex`) bridges Codex Responses turns through an
authenticated ChatGPT browser session. It is independent from the retired common
`chatgpt-web` provider and uses the MIT-noticed implementation under
`open-sse/vendor/codex-chatgpt-web/`.

## Common provider retirement

The former common provider IDs `chatgpt-web` and `cgpt-web` no longer ship because the
provenance of their pre-key/proof-of-work implementation could not be cleared. Explicit
requests to either ID, including slash-prefixed model IDs and persisted aliases, fail
closed with HTTP `410` and code **PROVIDER_RETIRED** before any upstream request.

Migration `163_retire_chatgpt_web.sql` tombstones matching provider connections and
invalidates their active session leases. It preserves connection history and API-key
allowlists; it does not add replacement access to an allowlist. The Codex provider and
its connections are not matched by this retirement.

## Prerequisites

- a full Cookie header from a signed-in ChatGPT session;
- Chrome or Chromium for npm, systemd, and PM2 installs;
- with the Docker `web` profile, the internal Chromium service from
  `docker-compose.yml`;
- an OpenAI tunnel and a ChatGPT custom connector for local Codex tools.

The tunnel is only needed for tool turns. The `pro` model is read-only and does not need
a local tool connector.

## Dashboard setup

1. Open the **ChatGPT Web (Codex)** provider and add a connection.
2. Paste the full ChatGPT Cookie header, tunnel ID, runtime key, and custom connector
   name.
3. Run the connection check. OmniRoute opens a headless Temporary Chat and detects
   whether `pro` is available for the account.
4. Save the connection. OmniRoute replaces the pasted cookie with the verified
   Playwright storage state and stores it with the runtime key through the encrypted
   credential abstraction.

The raw cookie is not retained after a successful save. When the session expires, open
the connection, paste a fresh full Cookie header, and rerun the check. The doctor status
in the edit dialog reports browser, storage state, sign-in, Temporary Chat, tunnel,
connector, and tool round-trip separately.

> Never commit a real cookie, runtime key, storage state, or capability token. Test and
> documentation values must always be placeholders.

## Models and combos

The fixed model routes are:

- `chatgpt-web-codex/instant`
- `chatgpt-web-codex/medium`
- `chatgpt-web-codex/high`
- `chatgpt-web-codex/extra-high`
- `chatgpt-web-codex/pro`

Add one of them to a combo like any other model. The Codex app sends the combo name as
`model` to the regular Responses endpoint, `/v1/responses`; there is no separate Codex
endpoint or mode switch.

`pro` does not run local tools. A forced tool makes that combo target incompatible. With
optional tools, the turn runs read-only and reports the limitation as commentary.

## Security model

- The native path requires a Responses request, a recognized Codex client, and matching
  thread and turn identities.
- Workspace, sandbox, approval policy, and tool catalog come from the native Codex shell;
  free-form prompt text is not authority for them.
- ChatGPT receives only a short-lived capability per turn. The MCP broker accepts only
  tools Codex offered in that exact turn.
- Auto-confirming **Allow once** only returns the tool request to Codex. Codex alone
  decides on approval and execution.
- Before the first output, a combo may fall back to another compatible target. After
  output begins, provider, model, connection, and browser turn remain pinned until the
  turn completes.
- Cookies, runtime keys, storage state, and capability tokens do not appear in provider
  responses or request logs.

## Headless VPS and Docker

For npm, systemd, and PM2 installs, OmniRoute detects common Chrome and Chromium paths.
Alternatively, set `CHATGPT_WEB_CODEX_CHROME_PATH`.

The Docker `web` profile starts `chatgpt-web-codex-browser` on the internal Compose
network. Its CDP port is not published on the host. The protected browser profile volume
is separate from the OmniRoute data volume, and the browser receives enough shared
memory. The internal CDP proxy listens only on port `9223` inside the Compose network;
Chrome remains bound to loopback in the sidecar.

A supervisor lease under `DATA_DIR` prevents multiple OmniRoute processes from owning
the same tunnel and broker state. A conflict is reported by the doctor.

## Interactive recovery

The normal path is headless. When ChatGPT requires an interactive sign-in or challenge,
the existing VNC browser infrastructure can be used for recovery. Browser UI and CDP
must remain reachable only over loopback, an authenticated management connection, or an
SSH tunnel; noVNC stays disabled during normal operation.

## WebSocket fallback

When a combo contains ChatGPT Web (Codex), the Responses WebSocket bridge requests the
HTTP/SSE fallback before connecting upstream. The transfer then goes through
`/v1/responses`.

## Verification

Run the provider controls without invoking the retired provider:

```bash
node --import tsx/esm --test \\
  tests/unit/chatgpt-web-codex.test.ts \\
  tests/unit/chatgpt-web-codex-turn-pin.test.ts \\
  tests/unit/chatgpt-web-environment-double-unescape.test.ts
```

Retirement regression guards live in:

- `tests/unit/chatgpt-web-retirement.test.ts`
- `tests/unit/chatgpt-web-runtime-block.test.ts`
- `tests/unit/chatgpt-web-image-handler-retirement.test.ts`
- `tests/unit/chatgpt-web-source-retirement.test.ts`
- `tests/unit/migration-168-retire-chatgpt-web.test.ts`
