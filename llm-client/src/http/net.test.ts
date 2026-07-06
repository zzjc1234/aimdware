import { test, expect, beforeEach } from "bun:test";
import { getProxyForUrl } from "./net";

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];

function clearProxyEnv() {
  for (const k of PROXY_ENV_KEYS) delete process.env[k];
}

beforeEach(clearProxyEnv);

test("returns undefined when no proxy env is set", () => {
  expect(getProxyForUrl("https://api.openai.com")).toBeUndefined();
});

test("HTTPS_PROXY matches https:// URLs", () => {
  process.env.HTTPS_PROXY = "http://corp:8080";
  expect(getProxyForUrl("https://api.openai.com")).toBe("http://corp:8080");
});

test("HTTP_PROXY matches http:// URLs", () => {
  process.env.HTTP_PROXY = "http://corp:8080";
  expect(getProxyForUrl("http://example.com")).toBe("http://corp:8080");
});

test("HTTPS_PROXY does not match http:// URLs", () => {
  process.env.HTTPS_PROXY = "http://corp:8080";
  expect(getProxyForUrl("http://example.com")).toBeUndefined();
});

test("ALL_PROXY is the fallback for any scheme", () => {
  process.env.ALL_PROXY = "socks5://fallback:1080";
  expect(getProxyForUrl("https://api.openai.com")).toBe(
    "socks5://fallback:1080",
  );
  expect(getProxyForUrl("http://example.com")).toBe("socks5://fallback:1080");
});

test("scheme-specific env beats ALL_PROXY", () => {
  process.env.ALL_PROXY = "socks5://fallback:1080";
  process.env.HTTPS_PROXY = "http://specific:8080";
  expect(getProxyForUrl("https://api.openai.com")).toBe("http://specific:8080");
});

test("lowercase env vars are accepted", () => {
  process.env.https_proxy = "http://lower:8080";
  expect(getProxyForUrl("https://api.openai.com")).toBe("http://lower:8080");
});

test("uppercase env vars beat lowercase if both set", () => {
  process.env.https_proxy = "http://lower:8080";
  process.env.HTTPS_PROXY = "http://upper:8080";
  expect(getProxyForUrl("https://api.openai.com")).toBe("http://upper:8080");
});

test("NO_PROXY exact host match disables proxy", () => {
  process.env.HTTPS_PROXY = "http://corp:8080";
  process.env.NO_PROXY = "api.openai.com";
  expect(getProxyForUrl("https://api.openai.com")).toBeUndefined();
});

test("NO_PROXY host:port match disables proxy", () => {
  process.env.HTTPS_PROXY = "http://corp:8080";
  process.env.NO_PROXY = "auth.openai.com:443,github.com:443";
  expect(getProxyForUrl("https://auth.openai.com/oauth/token")).toBeUndefined();
  expect(
    getProxyForUrl("https://github.com/login/device/code"),
  ).toBeUndefined();
  expect(getProxyForUrl("https://api.openai.com")).toBe("http://corp:8080");
});

test("NO_PROXY suffix match (.example.com matches sub.example.com)", () => {
  process.env.HTTPS_PROXY = "http://corp:8080";
  process.env.NO_PROXY = ".example.com";
  expect(getProxyForUrl("https://sub.example.com")).toBeUndefined();
  expect(getProxyForUrl("https://example.com")).toBeUndefined();
  expect(getProxyForUrl("https://other.com")).toBe("http://corp:8080");
});

test("NO_PROXY bare domain also matches subdomains", () => {
  process.env.HTTPS_PROXY = "http://corp:8080";
  process.env.NO_PROXY = "example.com";
  expect(getProxyForUrl("https://sub.example.com")).toBeUndefined();
  expect(getProxyForUrl("https://example.com")).toBeUndefined();
  expect(getProxyForUrl("https://other.com")).toBe("http://corp:8080");
});

test("NO_PROXY * disables all proxies", () => {
  process.env.HTTPS_PROXY = "http://corp:8080";
  process.env.NO_PROXY = "*";
  expect(getProxyForUrl("https://api.openai.com")).toBeUndefined();
});

test("localhost / 127.0.0.1 are never proxied by default", () => {
  process.env.HTTPS_PROXY = "http://corp:8080";
  process.env.HTTP_PROXY = "http://corp:8080";
  expect(getProxyForUrl("http://localhost:5000")).toBeUndefined();
  expect(getProxyForUrl("http://127.0.0.1:5000")).toBeUndefined();
  expect(getProxyForUrl("http://[::1]:5000")).toBeUndefined();
});
