import type { Config } from "../config";
import type { AuthStore } from "./auth-store";
import { createCodexProvider } from "./codex";
import { createCopilotProvider } from "./copilot";
import { createOpenAIProvider } from "./openai";
import type { ProviderRuntime } from "./plugin";

export function createProvider(
  upstream: Config["upstream"],
  authStore: AuthStore,
): ProviderRuntime {
  switch (upstream.plugin) {
    case "openai":
      if (!upstream.api_key) {
        throw new Error("upstream.api_key is required");
      }
      return createOpenAIProvider({
        base_url: upstream.base_url,
        api_key: upstream.api_key,
      });
    case "codex":
      return createCodexProvider({ authStore });
    case "copilot":
      return createCopilotProvider({ authStore });
  }
}
