import type { ProviderRuntime } from "./plugin";
import { openAICompatibleUrl } from "./plugin";

export type OpenAIProviderConfig = {
  base_url: string;
  api_key: string;
};

export function createOpenAIProvider(
  config: OpenAIProviderConfig,
): ProviderRuntime {
  return {
    id: "openai",
    label: "OpenAI-compatible API",
    async prepareChat(input) {
      const headers = new Headers(input.headers);
      headers.set("authorization", `Bearer ${config.api_key}`);
      return {
        url: openAICompatibleUrl(config.base_url, input.inboundUrl),
        method: input.method,
        headers,
        body: input.body,
      };
    },
  };
}
