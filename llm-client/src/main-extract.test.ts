import { test, expect } from "bun:test";
import { extractMessages } from "./main";

const enc = new TextEncoder();

test("extractMessages reads Chat Completions messages", () => {
  const messages = extractMessages(
    enc.encode(
      JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
      }),
    ),
  );

  expect(messages).toEqual([{ role: "user", content: "hi" }]);
});

test("extractMessages reads Responses input items", () => {
  const messages = extractMessages(
    enc.encode(
      JSON.stringify({
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
      }),
    ),
  );

  expect(messages).toEqual([
    { role: "user", content: [{ type: "input_text", text: "hi" }] },
  ]);
});
