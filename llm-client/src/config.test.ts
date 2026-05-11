import { test, expect } from "bun:test";
import { loadConfig } from "./config";

test("loadConfig parses a minimal config", () => {
  const yaml = `
student_token: st_abc123
course: ECE4721J
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
upstream:
  api_key: sk-x
backend_url: https://b.example
`;
  const config = loadConfig(yaml);

  expect(config.upstream.base_url).toBe("https://api.openai.com");
  expect(config.port).toBe(12345);
  expect(config.local_cache_dir).toBe("~/.cache/aimdware");
  expect(config.jbox_remote_path).toBe("aimdware/ECE4721J");
});

test("loadConfig rejects missing required fields", () => {
  const cases: Array<[string, string]> = [
    [
      "missing student_token",
      `course: X\nupstream:\n  api_key: k\nbackend_url: u`,
    ],
    [
      "missing course",
      `student_token: t\nupstream:\n  api_key: k\nbackend_url: u`,
    ],
    [
      "missing upstream.api_key",
      `student_token: t\ncourse: X\nupstream: {}\nbackend_url: u`,
    ],
    [
      "missing backend_url",
      `student_token: t\ncourse: X\nupstream:\n  api_key: k`,
    ],
  ];
  for (const [label, yaml] of cases) {
    expect(() => loadConfig(yaml), label).toThrow();
  }
});

test("loadConfig defaults upstream.type to 'openai'", () => {
  const yaml = `
student_token: st_x
course: ECE4721J
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
upstream:
  type: openai
  api_key: sk-x
backend_url: https://b.example
`;
  const config = loadConfig(yaml);
  expect(config.upstream.type).toBe("openai");
});
