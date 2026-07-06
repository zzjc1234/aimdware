import YAML from "yaml";
import { z } from "zod";

const SlugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.-]+$/, "must contain only A-Z, a-z, 0-9, _, ., or -");

const UpstreamSchema = z
  .object({
    type: z.enum(["openai", "codex", "copilot"]).optional(),
    plugin: z.enum(["openai", "codex", "copilot"]).optional(),
    base_url: z.string().optional(),
    api_key: z.string().optional(),
    model: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.type !== undefined &&
      value.plugin !== undefined &&
      value.type !== value.plugin
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["plugin"],
        message: "upstream.type and upstream.plugin must match",
      });
    }
    const plugin = value.plugin ?? value.type ?? "openai";
    if (plugin === "openai" && !value.api_key) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["api_key"],
        message: "upstream.api_key is required",
      });
    }
  })
  .transform((value) => {
    const plugin = value.plugin ?? value.type ?? "openai";
    return {
      ...value,
      type: plugin,
      plugin,
      base_url: value.base_url ?? "https://api.openai.com",
      api_key: value.api_key,
    };
  });

const RawConfigSchema = z.object({
  student_token: z.string().min(1, "student_token is required"),
  course: SlugSchema,
  assignment: SlugSchema,
  upstream: UpstreamSchema,
  port: z.number().int().positive().default(12345),
  local_cache_dir: z.string().default("~/.cache/aimdware"),
  jbox_remote_path: z.string().optional(),
  backend_url: z.string().min(1, "backend_url is required"),
  tbox_url: z.string().default("http://127.0.0.1:8089"),
  tbox_user: z.string().default(""),
  tbox_pass: z.string().default(""),
});

export type Config = z.infer<typeof RawConfigSchema> & {
  jbox_remote_path: string;
};

export function loadConfig(yamlText: string): Config {
  const raw = YAML.parse(yamlText);
  const parsed = RawConfigSchema.parse(raw);
  const canonicalJboxPath = `aimdware/${parsed.course}/${parsed.assignment}`;
  if (
    parsed.jbox_remote_path !== undefined &&
    parsed.jbox_remote_path !== canonicalJboxPath
  ) {
    throw new Error(`jbox_remote_path must be ${canonicalJboxPath}`);
  }
  return {
    ...parsed,
    jbox_remote_path: parsed.jbox_remote_path ?? canonicalJboxPath,
  };
}
