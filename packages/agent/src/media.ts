import { LouError } from "@lou/shared";
import OpenAI, { toFile } from "openai";

/** Text embeddings for semantic memory/skill retrieval. */
export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

/** Speech-to-text for voice input (DESIGN.md §6: voice is just another input method). */
export interface Transcriber {
  transcribe(audio: Buffer, filename: string, mimeType: string, signal?: AbortSignal): Promise<string>;
}

interface ClientOptions {
  apiKey: string;
  baseURL?: string;
  organization?: string;
}

export class OpenAIEmbeddings implements EmbeddingProvider {
  private readonly client: OpenAI;

  constructor(
    options: ClientOptions,
    readonly model: string,
  ) {
    this.client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL, organization: options.organization, maxRetries: 2 });
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (!texts.length) return [];
    try {
      const res = await this.client.embeddings.create({ model: this.model, input: texts.map((t) => t.slice(0, 8000)) }, { signal });
      return res.data.sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
    } catch (err) {
      throw new LouError("UPSTREAM_ERROR", `Embedding request failed: ${(err as Error).message}`, { cause: err });
    }
  }
}

export class OpenAITranscriber implements Transcriber {
  private readonly client: OpenAI;

  constructor(
    options: ClientOptions,
    private readonly model: string,
  ) {
    this.client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL, organization: options.organization, maxRetries: 1 });
  }

  async transcribe(audio: Buffer, filename: string, mimeType: string, signal?: AbortSignal): Promise<string> {
    try {
      const file = await toFile(audio, filename, { type: mimeType });
      const res = await this.client.audio.transcriptions.create({ file, model: this.model }, { signal });
      return res.text.trim();
    } catch (err) {
      throw new LouError("UPSTREAM_ERROR", `Transcription failed: ${(err as Error).message}`, { cause: err });
    }
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
