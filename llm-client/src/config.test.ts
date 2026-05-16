import { test, expect } from "bun:test";
import { loadConfig } from "./config";

test("loadConfig parses a minimal config", () => {
  const yaml = `
student_token: st_abc123
course: ECE4721J
assignment: hw1
upstream:
  api_key: sk-test
backend_url: https://aimdware.sjtu.edu
`;
  const config = loadConfig(yaml);

  expect(config.student_token).toBe("st_abc123");
  expect(config.course).toBe("ECE4721J");
  expect(config.upstream.api_key).toBe("sk-test");
  expect(config.backend_url).toBe("https://aimdware.sjtu.edu");
});

test("loadConfig applies defaults for optional fields", () => {
  const yaml = `
student_token: st_x
course: ECE4721J
assignment: hw1
upstream:
  api_key: sk-x
backend_url: https://b.example
`;
  const config = loadConfig(yaml);

  expect(config.upstream.base_url).toBe("https://api.openai.com");
  expect(config.port).toBe(12345);
  expect(config.local_cache_dir).toBe("~/.cache/aimdware");
  expect(config.jbox_remote_path).toBe("aimdware/ECE4721J/hw1");
});

test("loadConfig rejects missing required fields", () => {
  const cases: Array<[string, string]> = [
    [
      "missing student_token",
      `course: X\nassignment: hw1\nupstream:\n  api_key: k\nbackend_url: u`,
    ],
    [
      "missing course",
      `student_token: t\nassignment: hw1\nupstream:\n  api_key: k\nbackend_url: u`,
    ],
    [
      "missing assignment",
      `student_token: t\ncourse: X\nupstream:\n  api_key: k\nbackend_url: u`,
    ],
    [
      "missing upstream.api_key",
      `student_token: t\ncourse: X\nassignment: hw1\nupstream: {}\nbackend_url: u`,
    ],
    [
      "missing backend_url",
      `student_token: t\ncourse: X\nassignment: hw1\nupstream:\n  api_key: k`,
    ],
  ];
  for (const [label, yaml] of cases) {
    expect(() => loadConfig(yaml), label).toThrow();
  }
});

test("loadConfig rejects course and assignment values the backend would reject", () => {
  const cases: Array<[string, string]> = [
    ["course with slash", "course: ECE/4721J\nassignment: hw1"],
    ["assignment with space", "course: ECE4721J\nassignment: hw 1"],
    ["assignment with non-ascii", "course: ECE4721J\nassignment: 作业1"],
  ];
  for (const [label, fields] of cases) {
    const yaml = `
student_token: st_x
${fields}
upstream:
  api_key: sk-x
backend_url: https://b.example
`;
    expect(() => loadConfig(yaml), label).toThrow();
  }
});

test("loadConfig rejects jbox_remote_path that disagrees with course and assignment", () => {
  const yaml = `
student_token: st_x
course: ECE4721J
assignment: hw1
jbox_remote_path: aimdware/OTHER/hw2
upstream:
  api_key: sk-x
backend_url: https://b.example
`;
  expect(() => loadConfig(yaml)).toThrow();
});

test("loadConfig defaults upstream.type to 'openai'", () => {
  const yaml = `
student_token: st_x
course: ECE4721J
assignment: hw1
upstream:
  api_key: sk-x
backend_url: https://b.example
`;
  const config = loadConfig(yaml);
  expect(config.upstream.type).toBe("openai");
});

test("loadConfig parses an explicit upstream.type", () => {
  const yaml = `
student_token: st_x
course: ECE4721J
assignment: hw1
upstream:
  type: openai
  api_key: sk-x
backend_url: https://b.example
`;
  const config = loadConfig(yaml);
  expect(config.upstream.type).toBe("openai");
});

test("loadConfig parses subscription plugins without an api_key", () => {
  for (const plugin of ["codex", "copilot"] as const) {
    const yaml = `
student_token: st_x
course: ECE4721J
assignment: hw1
upstream:
  plugin: ${plugin}
backend_url: https://b.example
`;
    const config = loadConfig(yaml);
    expect(config.upstream.plugin).toBe(plugin);
    expect(config.upstream.type).toBe(plugin);
    expect(config.upstream.api_key).toBeUndefined();
  }
});

test("loadConfig keeps upstream.type as a backward-compatible plugin alias", () => {
  const yaml = `
student_token: st_x
course: ECE4721J
assignment: hw1
upstream:
  type: copilot
backend_url: https://b.example
`;
  const config = loadConfig(yaml);
  expect(config.upstream.plugin).toBe("copilot");
  expect(config.upstream.type).toBe("copilot");
});

test("loadConfig rejects api-key OpenAI upstreams without an api_key", () => {
  const yaml = `
student_token: st_x
course: ECE4721J
assignment: hw1
upstream:
  plugin: openai
backend_url: https://b.example
`;
  expect(() => loadConfig(yaml)).toThrow("upstream.api_key is required");
});

test("loadConfig rejects conflicting upstream.type and upstream.plugin", () => {
  const yaml = `
student_token: st_x
course: ECE4721J
assignment: hw1
upstream:
  type: codex
  plugin: copilot
backend_url: https://b.example
`;
  expect(() => loadConfig(yaml)).toThrow(
    "upstream.type and upstream.plugin must match",
  );
});
