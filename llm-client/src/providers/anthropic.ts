import {
  openAICompatibleUrl,
  UnsupportedProviderProtocolError,
  type ProviderRuntime,
} from "./plugin";

export type AnthropicProviderConfig = {
  base_url: string;
  api_key: string;
};

export function createAnthropicProvider(
  config: AnthropicProviderConfig,
): ProviderRuntime {
  return {
    id: "anthropic",
    label: "Anthropic-compatible API",
    async prepareChat() {
      throw new UnsupportedProviderProtocolError(
        "provider anthropic does not support /v1/chat/completions",
      );
    },
    async prepareResponses() {
      throw new UnsupportedProviderProtocolError(
        "provider anthropic does not support /v1/responses",
      );
    },
    async prepareMessages(input) {
      const headers = new Headers(input.headers);
      headers.delete("authorization");
      headers.delete("x-api-key");
      headers.set("authorization", `Bearer ${config.api_key}`);
      headers.set("x-api-key", config.api_key);
      if (!headers.has("anthropic-version")) {
        headers.set("anthropic-version", "2023-06-01");
      }
      return {
        url: openAICompatibleUrl(config.base_url, input.inboundUrl),
        method: input.method,
        headers,
        body: input.body,
      };
    },
  };
}
