"""Checks the parts of the voice pipeline that don't need the models: reading numbers, swapping in
sound-it-out spellings, turning word times into mouth shapes, and the server's answers (speaking
and embedding).

Run: cd services/models && uv run pytest
"""

import base64
import io

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

import server
from speak import mouth_shapes, number_words
from voices import RATE, respell, spoken


class Dictionary:
    """A stand-in for the CMU dictionary with just the words these tests use."""

    WORDS = {"hi": ["HH", "AY"], "map": ["M", "AE", "P"], "vector": ["V", "EH", "K", "T", "ER"]}

    def sounds(self, word):
        return self.WORDS[word.lower().strip(".,")]


@pytest.mark.parametrize(
    ("n", "said"),
    [(7, "seven"), (42, "forty two"), (200, "two hundred"), (2005, "two thousand five"), (2028, "twenty twenty eight"), (1999, "nineteen ninety nine")],
)
def test_numbers_are_said_as_people_say_them(n, said):
    assert " ".join(number_words(n)) == said


def test_spellings_swap_in_for_the_voice_and_keep_punctuation():
    table = {"pgvector": "P G vector", "Qdrant": "quadrant"}
    assert spoken("It uses pgvector, not Qdrant.", table) == "It uses P G vector, not quadrant."
    # Each on-screen word keeps its real spelling, paired with what the voice says for it.
    assert respell("pgvector,", table) == [("pgvector,", ["P", "G", "vector,"])]


def test_a_lone_dash_stays_in_the_voice_text_for_its_pause():
    assert respell("yes — really", {}) == [("yes", ["yes —"]), ("really", ["really"])]


def test_mouth_shapes_follow_the_words_and_close_between_them():
    shapes = mouth_shapes([(["hi"], 0.2, 0.5), (["map."], 0.9, 1.3)], Dictionary())
    names = [s for _, s in shapes]
    # Closed before the first word, "h" borrows the vowel's shape, closed in the long gap, closed at the end.
    assert names == ["sil", "aa", "sil", "PP", "E", "PP", "sil"]
    assert shapes[1] == [0.2, "aa"] and shapes[-1] == [1.3, "sil"]


def test_spelled_out_letters_get_the_mouth_shapes_of_their_names():
    # "P G vector": P is "pee", G is "gee", not the dictionary's one-letter words.
    names = [s for _, s in mouth_shapes([(["P", "G", "vector"], 0.0, 1.0)], Dictionary())]
    assert names[:4] == ["PP", "ih", "CH", "ih"]


class FakeSpeaker:
    def say(self, text):
        audio = np.zeros(RATE // 2, dtype=np.float32)
        return audio, {"text": text, "spoken": text, "duration": 0.5, "words": [], "visemes": [[0.0, "sil"]], "timing": {}}


class FakeEmbedder:
    def embed(self, texts, kind="passage"):
        # Queries and passages differ, so a test can tell which way a text was embedded.
        return [[1.0 if kind == "query" else 0.0, float(len(t))] for t in texts]


@pytest.fixture
def client(monkeypatch):
    # Without `with`, TestClient doesn't start the app, so the real models never load.
    monkeypatch.setitem(server.state, "speaker", None)
    monkeypatch.setitem(server.state, "embedder", None)
    return TestClient(server.app)


@pytest.fixture
def loaded(monkeypatch):
    monkeypatch.setitem(server.state, "speaker", FakeSpeaker())
    monkeypatch.setitem(server.state, "embedder", FakeEmbedder())


def test_health_says_loading_until_every_model_is_ready(client, monkeypatch):
    assert client.get("/health").status_code == 503
    monkeypatch.setitem(server.state, "speaker", FakeSpeaker())
    assert client.get("/health").status_code == 503
    monkeypatch.setitem(server.state, "embedder", FakeEmbedder())
    assert client.get("/health").json()["ok"] is True


def test_speak_returns_the_timing_and_a_playable_wav(client, loaded):
    body = client.post("/speak", json={"text": "  Hello there.  "}).json()
    assert body["text"] == "Hello there."
    audio, rate = sf.read(io.BytesIO(base64.b64decode(body["audio"])))
    assert rate == RATE and len(audio) == RATE // 2


@pytest.mark.parametrize("text", ["", "   ", "x" * (server.MAX_CHARS + 1)])
def test_speak_refuses_empty_or_overlong_text(client, loaded, text):
    assert client.post("/speak", json={"text": text}).status_code == 400


def test_embed_returns_one_vector_per_text_in_order(client, loaded):
    body = client.post("/embed", json={"texts": ["one", "three"], "kind": "query"}).json()
    assert body["vectors"] == [[1.0, 3.0], [1.0, 5.0]]
    assert body["model"] == server.EMBEDDING and body["dims"] == server.DIMS
    # Passages are the default.
    assert client.post("/embed", json={"texts": ["one"]}).json()["vectors"] == [[0.0, 3.0]]


@pytest.mark.parametrize(
    "body",
    [
        {"texts": []},
        {"texts": ["fine", "  "]},
        {"texts": ["x" * (server.MAX_EMBED_CHARS + 1)]},
        {"texts": ["a"] * (server.MAX_TEXTS + 1)},
        {"texts": ["fine"], "kind": "poem"},
    ],
)
def test_embed_refuses_bad_requests(client, loaded, body):
    assert client.post("/embed", json=body).status_code in (400, 422)


def test_embed_waits_for_the_models(client):
    assert client.post("/embed", json={"texts": ["hi"]}).status_code == 503
