import type { SessionEntry } from "../harness.ts";
import type { ModelContextItem } from "../models/transport.ts";
import { buildResumePrompt, latestCompletedCompaction } from "./compaction.ts";

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

/**
 * Durable handoff text for resume. New completed entries carry validated
 * rendered markdown; older entries already stored prose in the same field.
 * Neither form requires reading any filesystem location.
 */
function resumeHandoffText(entry: SessionEntry): string | null {
  const handoff = entry.payload.handoff;
  if (typeof handoff === "string" && handoff.trim()) return handoff;
  return null;
}

export function buildModelContext(entries: SessionEntry[]): ModelContextItem[] {
  const context: ModelContextItem[] = [];
  const completed = latestCompletedCompaction(entries);
  const handoff = completed ? resumeHandoffText(completed.entry) : null;
  // A corrupt/missing summary cannot authorize dropping any earlier context.
  const compaction = handoff === null ? null : completed;
  const visibleEntries = (compaction ? entries.slice(compaction.index + 1) : entries).filter(
    (entry) => entry.payload.purpose !== "compaction",
  );
  // A run can contain many provider steps. Bind replay to the immediately
  // following assistant/tool exchange, never the last response of the whole run.
  let pendingResponse:
    | {
        runId: string;
        response: import("../models/transport.ts").ProviderResponseMetadata;
      }
    | undefined;
  const takeReplay = (runId: unknown) => {
    if (!pendingResponse || pendingResponse.runId !== runId) return undefined;
    const { response } = pendingResponse;
    pendingResponse = undefined;
    if (!response.replay) return undefined;
    return {
      ...response.replay,
      source: response.replay.source ?? {
        api: response.api,
        provider: response.provider,
        model: response.model,
      },
    };
  };
  if (compaction && handoff !== null) {
    context.push({
      type: "user_message",
      text: buildResumePrompt(handoff),
      model: compaction.entry.payload.model as { connectionId: string; modelId: string },
      reasoning: text(compaction.entry.payload.reasoning, "none"),
    });
  }
  for (const entry of visibleEntries) {
    switch (entry.kind) {
      case "provider_response":
        if (
          typeof entry.payload.runId === "string" &&
          entry.payload.response &&
          typeof entry.payload.response === "object"
        ) {
          pendingResponse = {
            runId: entry.payload.runId,
            response: entry.payload
              .response as import("../models/transport.ts").ProviderResponseMetadata,
          };
        }
        break;
      case "user_message":
        pendingResponse = undefined;
        context.push({
          type: "user_message",
          text: text(entry.payload.text),
          model: entry.payload.model as { connectionId: string; modelId: string },
          reasoning: text(entry.payload.reasoning, "none"),
        });
        break;
      case "assistant_message":
        context.push({
          type: "assistant_message",
          text: text(entry.payload.text),
          replay: takeReplay(entry.payload.runId),
        });
        break;
      case "tool_call": {
        const replay = takeReplay(entry.payload.runId);
        // Thinking-only tool responses have no durable assistant_message entry.
        if (replay) context.push({ type: "assistant_message", text: "", replay });
        context.push({
          type: "tool_call",
          toolCallId: text(entry.payload.toolCallId),
          name: text(entry.payload.name),
          input: entry.payload.input,
        });
        break;
      }
      case "tool_result":
        context.push({
          type: "tool_result",
          toolCallId: text(entry.payload.toolCallId),
          name: text(entry.payload.name),
          output: entry.payload.output,
        });
        break;
      default:
        break;
    }
  }
  return context;
}
