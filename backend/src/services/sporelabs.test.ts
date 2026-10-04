/**
 * SporeLabs chat client + the IQ agent's Claude <-> OpenAI message adapter.
 *
 * Run: npx tsx src/services/sporelabs.test.ts
 */
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { sporelabsChatCompletions, sporelabsChatText } from "./sporelabs";
import { callClaude, toOpenAIMessages } from "./iq-agent/claude";

let checks = 0;
let failures = 0;

function assert(condition: boolean, message: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

process.env.SPORELABS_SECRET_ARN = "arn:aws:secretsmanager:us-west-2:1:secret:sl";
(SecretsManagerClient.prototype as unknown as { send: unknown }).send =
  async () => ({ SecretString: "sk-test" });

type Captured = { url: string; body: Record<string, unknown>; auth: string };
const calls: Captured[] = [];
let responses: Array<{ status: number; body: unknown }> = [];

globalThis.fetch = (async (url: string, init: RequestInit) => {
  calls.push({
    url: String(url),
    body: JSON.parse(String(init.body)),
    auth: String((init.headers as Record<string, string>).Authorization),
  });
  const next = responses.shift() ?? { status: 500, body: { error: "none" } };
  return new Response(JSON.stringify(next.body), { status: next.status });
}) as typeof fetch;

function ok(message: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    status: 200,
    body: {
      choices: [{ finish_reason: "stop", message }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
      ...extra,
    },
  };
}

async function main() {
  // Sampling params are only sent when the caller sets them, so each call
  // keeps the provider defaults it had before the move.
  calls.length = 0;
  responses = [ok({ content: "hi" })];
  await sporelabsChatText({ model: "anthropic/claude-3-haiku", user: "x" });
  assert(calls[0].url === "https://sporelabs.dev/v1/chat/completions", "chat URL");
  assert(calls[0].auth === "Bearer sk-test", "bearer key");
  assert(!("temperature" in calls[0].body), "temperature omitted when unset");
  assert(!("max_tokens" in calls[0].body), "max_tokens omitted when unset");
  assert(calls[0].body.model === "anthropic/claude-3-haiku", "model passed through");

  // A relayed upstream error on a 200 is transient: retried once by default.
  calls.length = 0;
  responses = [
    { status: 200, body: { error: { message: "Temporary", code: "upstream_unavailable" } } },
    ok({ content: "second" }),
  ];
  const text = await sporelabsChatText({ model: "m", user: "x", maxTokens: 5 });
  assert(text === "second", "retried after upstream_unavailable");
  assert(calls.length === 2, "two attempts");
  assert(calls[0].body.max_tokens === 5, "max_tokens sent when set");

  // 400 is not retried.
  calls.length = 0;
  responses = [{ status: 400, body: { error: { message: "bad" } } }];
  let threw = false;
  try {
    await sporelabsChatCompletions({ model: "m", messages: [], attempts: 3 });
  } catch {
    threw = true;
  }
  assert(threw && calls.length === 1, "400 fails without retry");

  // Adapter: cache breakpoints survive, tool results come before user content.
  const messages = toOpenAIMessages(
    [
      { type: "text", text: "sys" },
      { type: "text", text: "facts", cache_control: { type: "ephemeral" } },
    ],
    [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "looking" },
          { type: "tool_use", id: "t1", name: "frames", input: { at: 3 } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "frame ok" },
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAA" } },
            ],
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: "next" },
        ],
      },
    ],
  );
  const sys = messages[0].content as Array<Record<string, unknown>>;
  assert(messages[0].role === "system" && sys.length === 2, "system parts kept");
  assert(!!sys[1].cache_control && !sys[0].cache_control, "system cache_control on the right block");
  assert(messages[2].role === "assistant" && messages[2].tool_calls?.[0].id === "t1", "tool_use -> tool_calls");
  assert(messages[2].tool_calls?.[0].function.arguments === '{"at":3}', "tool args serialized");
  assert(messages[3].role === "tool" && messages[3].tool_call_id === "t1", "tool_result -> tool message");
  const toolParts = messages[3].content as Array<Record<string, unknown>>;
  assert(Array.isArray(toolParts) && !!toolParts[0].cache_control, "tool_result cache_control kept");
  assert(toolParts[0].text === "frame ok", "tool text flattened");
  const trailing = messages[4].content as Array<Record<string, unknown>>;
  assert(messages[4].role === "user" && trailing[0].type === "image_url", "tool image moved to user turn");
  assert(trailing[1].text === "next", "user text after tool image");

  // callClaude: stop reason and cache-aware usage map back to Anthropic shape.
  calls.length = 0;
  responses = [
    {
      status: 200,
      body: {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [{ id: "t2", type: "function", function: { name: "cut", arguments: "{\"a\":1}" } }],
            },
          },
        ],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 700, cache_write_tokens: 200 },
        },
      },
    },
  ];
  const res = await callClaude({
    system: [{ type: "text", text: "s" }],
    messages: [{ role: "user", content: [{ type: "text", text: "u" }] }],
    tools: [{ name: "cut", description: "d", input_schema: { type: "object", properties: {} } }],
    maxTokens: 100,
    temperature: 0.4,
    toolChoice: { type: "any" },
  });
  assert(calls[0].body.model === "anthropic/claude-sonnet-5.5", "IQ agent pinned to Sonnet 5.5");
  // Sonnet 5.5 rejects both with a 400.
  assert(!("temperature" in calls[0].body), "temperature dropped for Sonnet 5.5");
  assert(calls[0].body.tool_choice === "auto", "forced tool_choice relaxed to auto for Sonnet 5.5");
  assert(res.stopReason === "tool_use", "tool_calls -> tool_use");
  assert(res.usage.inputTokens === 100, "input tokens exclude cache reads/writes");
  assert(res.usage.cacheReadTokens === 700 && res.usage.cacheCreationTokens === 200, "cache usage mapped");
  const block = res.blocks[0] as { type: string; input: Record<string, unknown> };
  assert(block.type === "tool_use" && block.input.a === 1, "tool call -> tool_use block");

  // An env rollback to Sonnet 4.5 keeps the sampling and forcing it accepted.
  const tool = { type: "function" as const, function: { name: "cut" } };
  calls.length = 0;
  responses = [ok({ content: "a" }), ok({ content: "b" })];
  await sporelabsChatCompletions({
    model: "anthropic/claude-sonnet-4.5",
    messages: [],
    tools: [tool],
    toolChoice: "required",
    temperature: 0.4,
  });
  await sporelabsChatCompletions({
    model: "anthropic/claude-sonnet-4.5",
    messages: [],
    tools: [tool],
    toolChoice: { type: "function", function: { name: "cut" } },
  });
  assert(calls[0].body.temperature === 0.4, "Sonnet 4.5 temperature kept");
  assert(calls[0].body.tool_choice === "required", "Sonnet 4.5 tool_choice required kept");
  assert(
    (calls[1].body.tool_choice as { type?: string })?.type === "function",
    "Sonnet 4.5 named tool_choice kept",
  );

  // Sonnet 5.5: unforced choices pass through untouched.
  calls.length = 0;
  responses = [ok({ content: "c" })];
  await sporelabsChatCompletions({
    model: "anthropic/claude-sonnet-5.5",
    messages: [],
    tools: [tool],
    toolChoice: "none",
  });
  assert(calls[0].body.tool_choice === "none", "Sonnet 5.5 tool_choice none kept");

  if (failures > 0) {
    console.error(`sporelabs: ${failures}/${checks} checks failed`);
    process.exit(1);
  }
  console.log(`sporelabs: ${checks} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
