import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { buildModelContext } from "../context/build-context.ts";
import type { SessionEntry } from "../harness.ts";
import { PiAiTransport, toPiContext, type PiAiRoute } from "./pi-ai.ts";
import {
  ModelTransportError,
  type ModelContextItem,
  type ModelRequest,
  type ProviderResponseMetadata,
} from "./transport.ts";

const route: PiAiRoute = {
  backendId: "anthropic-test",
  label: "Anthropic test",
  protocol: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  modelId: "claude-opus-test",
  apiKey: "test-key",
  reasoning: true,
};
const model: Model<"anthropic-messages"> = {
  id: route.modelId,
  name: route.label,
  api: "anthropic-messages",
  provider: route.backendId,
  baseUrl: route.baseUrl,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 16_000,
};
const user: ModelContextItem = {
  type: "user_message",
  text: "inspect",
  model: { connectionId: route.backendId, modelId: route.modelId },
  reasoning: "medium",
};
function request(context: ModelContextItem[]): ModelRequest {
  return {
    identity: { hostId: "host", sessionId: "session", runId: "run", principalId: "local" },
    projectDirectory: "/project",
    systemPrompt: "System",
    tools: ["read"],
    context,
  };
}
function entry(kind: SessionEntry["kind"], payload: SessionEntry["payload"]): SessionEntry {
  return {
    id: kind,
    sessionId: "session",
    sequence: 0,
    kind,
    payload,
    createdAt: "2026-11-07T00:00:00Z",
  };
}
async function metadata(content: AssistantMessage["content"]): Promise<ProviderResponseMetadata> {
  const response: AssistantMessage = {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { ...model.cost, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
  const transport = new PiAiTransport({
    resolve: () => route,
    streams: {
      "anthropic-messages": () => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "done", reason: "toolUse", message: response });
          stream.end();
        });
        return stream;
      },
    },
  });
  for await (const event of transport.stream(request([user]), new AbortController().signal)) {
    if (event.type === "completed") return JSON.parse(JSON.stringify(event.response));
  }
  throw new Error("No completed response");
}
async function payloadFor(context: ModelContextItem[]) {
  let payload: unknown;
  const transport = new PiAiTransport({
    resolve: () => route,
    inspectPayload: (value) => {
      payload = value;
      throw new Error("inspection complete");
    },
  });
  await expect(async () => {
    for await (const event of transport.stream(request(context), new AbortController().signal))
      void event;
  }).rejects.toBeInstanceOf(ModelTransportError);
  expect(payload).toBeDefined();
  return payload;
}

test("round-trips signed Anthropic thinking unchanged through durable tool history", async () => {
  const thinking = "  Think exactly.\nUnicode: café 🧠\n";
  const response = await metadata([
    { type: "thinking", thinking, thinkingSignature: "signed-original-text" },
    { type: "thinking", thinking: "[redacted]", thinkingSignature: "opaque", redacted: true },
    { type: "text", text: "Checking." },
    { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } },
  ]);
  const context = buildModelContext([
    entry("user_message", user),
    entry("provider_response", { runId: "run", response }),
    entry("assistant_reasoning", { runId: "run", text: thinking }),
    entry("assistant_message", { runId: "run", text: "Checking." }),
    entry("tool_call", { runId: "run", toolCallId: "call_1", name: "read", input: { path: "a" } }),
    entry("tool_result", { runId: "run", toolCallId: "call_1", name: "read", output: "result" }),
  ]);
  expect(await payloadFor(context)).toMatchObject({
    messages: [
      { role: "user" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking, signature: "signed-original-text" },
          { type: "redacted_thinking", data: "opaque" },
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "call_1" },
        ],
      },
      { role: "user" },
    ],
  });
});

test("never sends OpenAI encrypted reasoning or incomplete legacy signatures to Anthropic", async () => {
  const payload = await payloadFor([
    user,
    {
      type: "assistant_message",
      text: "working",
      replay: {
        items: [
          { type: "reasoning", encryptedContent: "foreign-openai-reasoning" },
          { type: "thinking", signature: "legacy-missing-text" },
        ],
      },
    },
  ]);
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toContain("foreign-openai-reasoning");
  expect(serialized).not.toContain("legacy-missing-text");
  expect(serialized).toContain("working");
});

test("thinking-only tool responses retain their own replay across multiple steps in one run", async () => {
  const first = await metadata([
    { type: "thinking", thinking: "First", thinkingSignature: "signature-1" },
  ]);
  const second = await metadata([
    { type: "thinking", thinking: "Second", thinkingSignature: "signature-2" },
  ]);
  const context = buildModelContext([
    entry("user_message", user),
    entry("provider_response", { runId: "run", response: first }),
    entry("assistant_reasoning", { runId: "run", text: "First" }),
    entry("tool_call", { runId: "run", toolCallId: "call_1", name: "read", input: {} }),
    entry("tool_result", { runId: "run", toolCallId: "call_1", name: "read", output: "one" }),
    entry("provider_response", { runId: "run", response: second }),
    entry("assistant_message", { runId: "run", text: "Done" }),
  ]);
  expect(toPiContext(request(context), model).messages).toMatchObject([
    { role: "user" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "First", thinkingSignature: "signature-1" },
        { type: "text", text: "" },
        { type: "toolCall", id: "call_1" },
      ],
    },
    { role: "toolResult" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Second", thinkingSignature: "signature-2" },
        { type: "text", text: "Done" },
      ],
    },
  ]);
});

test("does not carry signed replay into another model", async () => {
  const response = await metadata([
    { type: "thinking", thinking: "Original", thinkingSignature: "model-bound-signature" },
  ]);
  const context = toPiContext(
    request([user, { type: "assistant_message", text: "public", replay: response.replay }]),
    { ...model, id: "another-model" },
  );
  expect(JSON.stringify(context)).not.toContain("model-bound-signature");
  expect(JSON.stringify(context)).toContain("public");
});

test.each(["none", "off"])(
  "reasoning %s disables thinking in the Anthropic request",
  async (reasoning) => {
    expect(await payloadFor([{ ...user, reasoning }])).toHaveProperty("thinking.type", "disabled");
  },
);
