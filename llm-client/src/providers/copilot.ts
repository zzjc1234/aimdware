import type { AuthStore, OAuthAuth } from "./auth-store";
import type { ProviderRuntime } from "./plugin";
import { openAICompatibleUrl, userAgent } from "./plugin";

export type CopilotProviderOpts = {
  authStore: AuthStore;
};

function normalizeDomain(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function base(enterpriseUrl?: string): string {
  return enterpriseUrl
    ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}`
    : "https://api.githubcopilot.com";
}

function isVisionBody(body: ArrayBuffer | undefined): boolean {
  if (!body) return false;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      messages?: Array<{ content?: unknown }>;
      input?: Array<{ content?: unknown }>;
    };
    const messages = parsed.messages ?? parsed.input ?? [];
    return messages.some((msg) => {
      const content = msg.content;
      return (
        Array.isArray(content) &&
        content.some(
          (part) =>
            typeof part === "object" &&
            part !== null &&
            ["image_url", "input_image", "image"].includes(
              String((part as { type?: unknown }).type),
            ),
        )
      );
    });
  } catch {
    return false;
  }
}

async function currentAuth(authStore: AuthStore): Promise<OAuthAuth> {
  const auth = await authStore.get("copilot");
  if (!auth || auth.type !== "oauth") {
    throw new Error(
      "GitHub Copilot subscription is not logged in. Run `aimdware-router auth login copilot` first.",
    );
  }
  return auth;
}

export function createCopilotProvider(
  opts: CopilotProviderOpts,
): ProviderRuntime {
  return {
    id: "copilot",
    label: "GitHub Copilot subscription",
    async prepareChat(input) {
      const auth = await currentAuth(opts.authStore);
      const headers = new Headers(input.headers);
      headers.delete("authorization");
      headers.delete("Authorization");
      headers.delete("x-api-key");
      headers.set("authorization", `Bearer ${auth.refresh}`);
      headers.set("User-Agent", userAgent());
      headers.set("Openai-Intent", "conversation-edits");
      headers.set("x-initiator", "user");
      if (isVisionBody(input.body)) {
        headers.set("Copilot-Vision-Request", "true");
      }

      return {
        url: openAICompatibleUrl(
          base(auth.enterprise_url ?? auth.enterpriseUrl),
          input.inboundUrl,
        ),
        method: input.method,
        headers,
        body: input.body,
      };
    },
  };
}
