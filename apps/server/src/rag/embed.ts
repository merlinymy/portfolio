/**
 * Asks the model server (services/models, POST /embed) for embeddings: 1,024 numbers per text,
 * where similar meanings get similar numbers. "query" is for a visitor's question, which the model
 * reads with an instruction first; "passage" for the text being searched.
 */
import { setting } from "../env.ts";

export const DIMS = 1024;
const PER_CALL = 64; // the server takes up to 256

export interface Embedded {
  model: string;
  vectors: number[][];
}

export interface EmbedOptions {
  /** How long one call to the model server may take. Default: 10 s for a visitor's question, 2 min for loading passages. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function embed(texts: string[], kind: "passage" | "query", options: EmbedOptions = {}): Promise<Embedded> {
  const base = setting("MODELS_URL", "http://127.0.0.1:8790");
  // A visitor is waiting on a question, so a stuck model server must end in an error (the chat then
  // apologizes), not in a reply that thinks forever. Loading the profile's passages is a batch job.
  const timeoutMs = options.timeoutMs ?? (kind === "query" ? 10_000 : 120_000);
  const fetchImpl = options.fetchImpl ?? fetch;
  const vectors: number[][] = [];
  let model = "";
  for (let start = 0; start < texts.length; start += PER_CALL) {
    const response = await fetchImpl(`${base}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: texts.slice(start, start + PER_CALL), kind }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error) => {
      throw new Error(`the model server at ${base} isn't answering (start it with npm run voice): ${error.message}`);
    });
    if (!response.ok) throw new Error(`the model server refused to embed (${response.status}): ${await response.text()}`);
    const body = (await response.json()) as { model: string; dims: number; vectors: number[][] };
    if (body.dims !== DIMS) throw new Error(`the model server's embeddings have ${body.dims} numbers, not ${DIMS}`);
    model = body.model;
    vectors.push(...body.vectors);
  }
  return { model, vectors };
}

/** A vector the way pgvector reads it: "[0.1,0.2,...]". */
export const asVector = (v: number[]) => `[${v.join(",")}]`;
