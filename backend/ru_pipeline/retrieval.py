"""Source-only BM25/RRF ordering of the entire archive; no link-count cutoff."""

from collections import Counter
import math
import re

K1 = 1.2
B = 0.75
RRF_K = 60
BATCH_SIZE = 10
TOKEN = re.compile(r"[^\W_]+(?:[-/][^\W_]+)*", re.UNICODE)


def features(source, character=False):
    words = TOKEN.findall(source.casefold().replace("ё", "е"))
    if not character:
        return Counter(words)
    parts = []
    for word in words:
        padded = "^" + word + "$"
        parts.extend(padded[index : index + 3] for index in range(len(padded) - 2))
    return Counter(parts)


class Index:
    def __init__(self, corpus):
        if not corpus or len({row["id"] for row in corpus}) != len(corpus):
            raise ValueError("Nonempty unique corpus required")
        self.rows = sorted(corpus, key=lambda row: row["id"])
        self.views = []
        for character in (False, True):
            counters = [features(row["source"], character) for row in self.rows]
            lengths = [sum(counter.values()) for counter in counters]
            frequency = Counter(term for counter in counters for term in counter)
            average = sum(lengths) / len(lengths) or 1.0
            self.views.append((character, counters, lengths, frequency, average))

    def rank(self, source):
        fused = {row["id"]: 0.0 for row in self.rows}
        view_scores = {}
        for character, counters, lengths, frequency, average in self.views:
            terms = set(features(source, character))
            scores = []
            for row, counter, length in zip(self.rows, counters, lengths, strict=True):
                value = 0.0
                for term in sorted(terms & counter.keys()):
                    occurrences = counter[term]
                    idf = math.log(
                        1
                        + (len(self.rows) - frequency[term] + 0.5)
                        / (frequency[term] + 0.5)
                    )
                    denominator = occurrences + K1 * (1 - B + B * length / average)
                    value += idf * occurrences * (K1 + 1) / denominator
                if not math.isfinite(value):
                    raise ValueError("Nonfinite BM25 score")
                view_scores.setdefault(row["id"], []).append(value)
                if value > 0:
                    scores.append((row["id"], value))
            scores.sort(key=lambda item: (-item[1], item[0]))
            for rank, (key, _score) in enumerate(scores, 1):
                fused[key] += 1.0 / (RRF_K + rank)
        ranked = sorted(fused, key=lambda key: (-fused[key], key))
        return [
            {
                "id": key,
                "rrf_score": fused[key],
                "word_bm25": view_scores[key][0],
                "char3_bm25": view_scores[key][1],
            }
            for key in ranked
        ]
