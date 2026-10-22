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

export async function embed(texts: string[], kind: "passage" | "query"): Promise<Embedded> {
  const base = setting("MODELS_URL", "http://127.0.0.1:8790");
  const vectors: number[][] = [];
  let model = "";
  for (let start = 0; start < texts.length; start += PER_CALL) {
    const response = await fetch(`${base}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: texts.slice(start, start + PER_CALL), kind }),
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
