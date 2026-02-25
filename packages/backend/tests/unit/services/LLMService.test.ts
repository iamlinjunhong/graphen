import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@graphen/shared";
import { LLMRateLimiter } from "../../../src/services/LLMRateLimiter.js";
import { LLMService } from "../../../src/services/LLMService.js";

describe("LLMService", () => {
  it("extracts entities and relations from JSON response", async () => {
    const client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    entities: [
                      {
                        name: "Graphen",
                        type: "Technology",
                        description: "GraphRAG app",
                        confidence: 0.95
                      }
                    ],
                    relations: []
                  })
                }
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20 }
          })
        }
      },
      embeddings: {
        create: vi.fn()
      }
    };

    const service = new LLMService(
      {
        apiKey: "test",
        chatModel: "qwen-max",
        embeddingModel: "text-embedding-v3"
      },
      {
        client,
        rateLimiter: new LLMRateLimiter({
          maxConcurrent: 5,
          maxRetries: 0,
          retryDelayMs: 1,
          requestsPerMinute: 200,
          timeoutMs: 5000
        })
      }
    );

    const result = await service.extractEntitiesAndRelations("Graphen uses Neo4j");
    expect(result.entities[0]?.name).toBe("Graphen");
    expect(result.entities[0]?.type).toBe("Technology");
    expect(service.getUsageRecords().length).toBe(1);
  });

  it("supports chat streaming and question analysis", async () => {
    const stream = createStream([
      { choices: [{ delta: { content: "你好，" } }] },
      { choices: [{ delta: { content: "我是 Graphen 助手。" } }] },
      { usage: { prompt_tokens: 12, completion_tokens: 15 }, choices: [] }
    ]);

    const client = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce(stream)
            .mockResolvedValueOnce({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      intent: "analytical",
                      key_entities: ["Graphen", "Neo4j"],
                      retrieval_strategy: {
                        use_graph: true,
                        use_vector: true,
                        graph_depth: 2,
                        vector_top_k: 5,
                        need_aggregation: false
                      },
                      rewritten_query: "Graphen 和 Neo4j 的关系"
                    })
                  }
                }
              ],
              usage: { prompt_tokens: 11, completion_tokens: 9 }
            })
        }
      },
      embeddings: {
        create: vi.fn().mockResolvedValue({
          data: [{ embedding: [0.1, 0.2, 0.3] }],
          usage: { prompt_tokens: 5 }
        })
      }
    };

    const service = new LLMService(
      {
        apiKey: "test",
        chatModel: "qwen-max",
        embeddingModel: "text-embedding-v3"
      },
      {
        client
      }
    );

    const messages: ChatMessage[] = [
      {
        id: "m1",
        sessionId: "s1",
        role: "user",
        content: "Graphen 是什么？",
        createdAt: new Date()
      }
    ];

    let output = "";
    for await (const chunk of service.chatCompletion(messages, {
      graphContext: "Graphen -[USES]-> Neo4j",
      retrievedChunks: "Graphen is a GraphRAG web app."
    })) {
      output += chunk;
    }

    expect(output).toContain("Graphen");

    const embedding = await service.generateEmbedding("Graphen");
    expect(embedding).toEqual([0.1, 0.2, 0.3]);

    const analysis = await service.analyzeQuestion("Graphen 和 Neo4j 有什么关系");
    expect(analysis.intent).toBe("analytical");
    expect(analysis.retrieval_strategy.use_graph).toBe(true);

    const records = service.getUsageRecords();
    expect(records.length).toBe(3);
    expect(records.some((record) => record.phase === "chat")).toBe(true);
    expect(records.some((record) => record.phase === "embedding")).toBe(true);
    expect(records.some((record) => record.phase === "analysis")).toBe(true);
  });
});

function createStream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      let index = 0;
      return {
        next: async () => {
          if (index >= chunks.length) {
            return { done: true, value: undefined };
          }
          const value = chunks[index];
          index += 1;
          return { done: false, value };
        }
      };
    }
  };
}
