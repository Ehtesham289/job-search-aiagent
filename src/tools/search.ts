import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env.js";

/**
 * Web search for §2.3's discovery loop.
 *
 * The model's judgment is spent on phrasing the query; pulling URLs out of the
 * results is code. Returns an empty list rather than throwing when no
 * credential is configured — discovery is an optional node, and a missing
 * search capability must degrade the run, not fail it.
 */
export interface SearchHit {
  url: string;
  title: string;
}

export async function webSearch(query: string, opts: { maxUses?: number; signal?: AbortSignal } = {}): Promise<SearchHit[]> {
  if (!env.hasApiKey || env.offline) return [];
  const client = new Anthropic({ maxRetries: 2 });
  try {
    const res = await client.beta.messages.create(
      {
        model: "claude-haiku-4-5",
        max_tokens: 2000,
        system:
          "You locate official career pages. Search, then reply with nothing but the URLs you found, one per line.",
        messages: [{ role: "user", content: query }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: opts.maxUses ?? 3 }],
      } as never,
      { signal: opts.signal },
    );

    const hits: SearchHit[] = [];
    for (const block of res.content) {
      // Server-tool errors arrive as HTTP 200 with an error object in place of
      // the result list — branch on shape before indexing.
      if (block.type === "web_search_tool_result") {
        const content = (block as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;
        for (const r of content as Array<{ url?: string; title?: string }>) {
          if (r.url) hits.push({ url: r.url, title: r.title ?? "" });
        }
      }
    }
    return hits;
  } catch {
    return [];
  }
}
