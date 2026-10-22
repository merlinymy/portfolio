"""Turns text into embeddings for the chat's search (plan §3.4, docs/phase-4-knowledge-plan.md):
lists of 1,024 numbers, where texts with similar meanings get similar numbers. The model is
Qwen3-Embedding-0.6B (Apache-2.0), run through Hugging Face transformers on the graphics chip
(PyTorch's MPS) when there is one.

Passages are embedded as they are. Questions get a one-line instruction first, saying what the
question is for; that's how this model is meant to be used, and it finds better passages.

Every vector has length 1, so comparing two is one dot product (their cosine similarity).

Run: cd services/models && uv run embed.py "A question." ["Another text." ...]
It prints how similar each later text is to the first.
"""

import argparse
import time

import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer

MODEL = "Qwen/Qwen3-Embedding-0.6B"
DIMS = 1024
TASK = "Given a recruiter's question about a job candidate, retrieve passages from the candidate's profile that answer it"
MAX_TOKENS = 1024  # far above any passage; longer text is cut
BATCH = 16


def as_query(text: str) -> str:
    return f"Instruct: {TASK}\nQuery:{text}"


class Embedder:
    def __init__(self, device: str | None = None):
        self.device = device or ("mps" if torch.backends.mps.is_available() else "cpu")
        # Half precision on the graphics chip, full on the CPU (where half is slow).
        dtype = torch.float16 if self.device == "mps" else torch.float32
        # Padding on the left puts every text's last token in the last position, which is the one
        # this model's embedding is read from.
        self.tokenizer = AutoTokenizer.from_pretrained(MODEL, padding_side="left")
        self.model = AutoModel.from_pretrained(MODEL, dtype=dtype).to(self.device).eval()

    def embed(self, texts: list[str], kind: str = "passage") -> list[list[float]]:
        if kind == "query":
            texts = [as_query(t) for t in texts]
        vectors: list[list[float]] = []
        for start in range(0, len(texts), BATCH):
            batch = self.tokenizer(
                texts[start : start + BATCH], padding=True, truncation=True, max_length=MAX_TOKENS, return_tensors="pt"
            ).to(self.device)
            with torch.inference_mode():
                last = self.model(**batch).last_hidden_state[:, -1]
            vectors += F.normalize(last.float(), p=2, dim=1).cpu().tolist()
        return vectors


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("question")
    parser.add_argument("texts", nargs="*")
    parser.add_argument("--device")
    args = parser.parse_args()
    started = time.perf_counter()
    embedder = Embedder(args.device)
    print(f"loaded {MODEL} on {embedder.device} in {time.perf_counter() - started:.1f} s")
    started = time.perf_counter()
    [question] = embedder.embed([args.question], "query")
    passages = embedder.embed(args.texts) if args.texts else []
    print(f"embedded {1 + len(passages)} texts in {time.perf_counter() - started:.2f} s")
    for text, vector in zip(args.texts, passages):
        print(f"{sum(a * b for a, b in zip(question, vector)):.3f}  {text}")


if __name__ == "__main__":
    main()
