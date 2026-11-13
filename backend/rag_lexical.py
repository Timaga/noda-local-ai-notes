"""Deterministic sparse lexical vectors for hybrid local note retrieval."""

import hashlib
import math
import re
from collections import Counter


LEXICAL_VECTOR_VERSION = "lexical-v1"


# Who: Tim Buglaev
# When: 2026-06-22
# What: Tokenize multilingual note text into words and character trigrams so lexical
#       retrieval remains robust to common inflections without language-specific rules.
def _lexical_terms(text):
    words = re.findall(r"[^\W_]+", str(text or "").casefold(), flags=re.UNICODE)
    terms = []
    for word in words:
        if len(word) < 2:
            continue
        terms.append(f"w:{word}")
        bounded = f"^{word}$"
        if len(bounded) >= 3:
            terms.extend(f"g:{bounded[index:index + 3]}" for index in range(len(bounded) - 2))
    return terms


def _term_index(term):
    digest = hashlib.blake2b(term.encode("utf-8", errors="ignore"), digest_size=4).digest()
    return int.from_bytes(digest, "big", signed=False)


# Who: Tim Buglaev
# When: 2026-06-22
# What: Build a bounded, deterministic sparse vector with sublinear term frequency;
#       hash collisions are merged and Qdrant applies collection-level IDF weighting.
def lexical_sparse_vector(text, max_features=2048):
    counts = Counter(_term_index(term) for term in _lexical_terms(text))
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:max(1, int(max_features))]
    ranked.sort(key=lambda item: item[0])
    return {
        "indices": [index for index, _ in ranked],
        "values": [1.0 + math.log(count) for _, count in ranked],
    }
