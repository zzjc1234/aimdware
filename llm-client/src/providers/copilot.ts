import type { AuthStore, OAuthAuth } from "./auth-store";
import type { ProviderRuntime } from "./plugin";
import { openAICompatibleUrl, userAgent } from "./plugin";

const SYNTHETIC_ATTACHMENT_PROMPT = "Attached media from tool result:";

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
  return classifyBody(body).isVision;
}

function isAgentBody(body: ArrayBuffer | undefined): boolean {
  return classifyBody(body).isAgent;
}

function classifyBody(body: ArrayBuffer | undefined): {
  isVision: boolean;
  isAgent: boolean;
} {
  if (!body) return { isVision: false, isAgent: false };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      messages?: Array<{ role?: unknown; content?: unknown }>;
      input?: Array<{ role?: unknown; content?: unknown }>;
    };
    if (Array.isArray(parsed.input)) {
      const last = parsed.input.at(-1);
      return {
        isVision: parsed.input.some((msg) =>
          hasContentPart(msg.content, ["input_image"]),
        ),
        isAgent: last?.role !== "user" || isSyntheticAttachmentMessage(last),
      };
    }
    if (Array.isArray(parsed.messages)) {
      const last = parsed.messages.at(-1);
      return {
        isVision: parsed.messages.some((msg) =>
          hasContentPart(msg.content, ["image_url"]),
        ),
        isAgent: last?.role !== "user" || isSyntheticAttachmentMessage(last),
      };
    }
  } catch {}
  return { isVision: false, isAgent: false };
}

function hasContentPart(content: unknown, types: readonly string[]): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        types.includes(String((part as { type?: unknown }).type)),
    )
  );
}

function isSyntheticAttachmentMessage(msg: unknown): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string")
    return content === SYNTHETIC_ATTACHMENT_PROMPT;
  return (
    Array.isArray(content) &&
    content.some((part) => {
      if (typeof part !== "object" || part === null) return false;
      const typed = part as { type?: unknown; text?: unknown };
      return (
        (typed.type === "text" || typed.type === "input_text") &&
        typed.text === SYNTHETIC_ATTACHMENT_PROMPT
      );
    })
  );
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
  const prepare = async (
    input: Parameters<ProviderRuntime["prepareChat"]>[0],
  ) => {
    const auth = await currentAuth(opts.authStore);
    const headers = new Headers(input.headers);
    headers.delete("authorization");
    headers.delete("Authorization");
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${auth.refresh}`);
    headers.set("User-Agent", userAgent());
    headers.set("Openai-Intent", "conversation-edits");
    headers.set("x-initiator", isAgentBody(input.body) ? "agent" : "user");
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
  };

  return {
    id: "copilot",
    label: "GitHub Copilot subscription",
    prepareChat: prepare,
    prepareResponses: prepare,
  };
}
