import YAML from "yaml";
import { z } from "zod";

const UpstreamSchema = z.object({
  type: z.enum(["openai", "codex", "copilot"]).default("openai"),
  base_url: z.string().default("https://api.openai.com"),
  api_key: z.string().min(1, "upstream.api_key is required"),
});

const RawConfigSchema = z.object({
  student_token: z.string().min(1, "student_token is required"),
  course: z.string().min(1, "course is required"),
  upstream: UpstreamSchema,
  port: z.number().int().positive().default(12345),
  local_cache_dir: z.string().default("~/.cache/aimdware"),
  jbox_remote_path: z.string().optional(),
  backend_url: z.string().min(1, "backend_url is required"),
});

export type Config = z.infer<typeof RawConfigSchema> & {
  jbox_remote_path: string;
};

export function loadConfig(yamlText: string): Config {
  const raw = YAML.parse(yamlText);
  const parsed = RawConfigSchema.parse(raw);
  return {
    ...parsed,
    jbox_remote_path:
      parsed.jbox_remote_path ?? `aimdware/${parsed.course}`,
  };
}
