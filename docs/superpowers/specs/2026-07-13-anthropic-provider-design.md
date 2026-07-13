# Anthropic Provider Design

## Goal

Remove GitHub Copilot support and add an `anthropic` upstream provider that
proxies Anthropic-compatible `/v1/messages` requests through one router
instance.

## Scope

Each router instance selects exactly one provider with `upstream.plugin`.
The `anthropic` provider is API-key based and exposes `POST /v1/messages`.
It sends the request unchanged to `<base_url>/v1/messages`, replaces client
credentials with `x-api-key: <api_key>`, and supplies
`anthropic-version: 2023-06-01` when the caller omitted it. Responses,
including SSE streams, are forwarded and recorded byte-for-byte.

`openai` and `codex` remain single-provider choices. They do not implement
the Messages protocol, so `/v1/messages` returns a clear 400 when either is
configured. No OpenAI/Anthropic request or response conversion is included.

GitHub Copilot support is removed entirely: provider code, OAuth device login,
auth status output, configuration values, tests, examples, and documentation.

## Design

The provider runtime gains an optional Messages preparation capability. The
HTTP layer routes `/v1/messages` to the selected provider through the same
header filtering, proxy selection, response streaming, and audit capture
path already used for Chat Completions and Responses. A missing capability is
reported as an unsupported-provider-protocol error before any upstream call.

The Anthropic provider is deliberately small: it owns protocol-specific URL
and headers only. Existing proxy and capture mechanisms own transport,
streaming, and recording. `base_url` defaults to `https://api.anthropic.com`;
`api_key` is required just as it is for the OpenAI API-key provider.

## Verification

Tests will prove configuration accepts `anthropic` and requires its key;
`/v1/messages` reaches the configured base URL with Anthropic credentials and
version header; caller-provided version headers are preserved; streamed
responses and audit bytes remain unchanged; unsupported providers return 400;
and no Copilot source, commands, configuration, or documentation remains.
