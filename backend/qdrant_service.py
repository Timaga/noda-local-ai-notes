import logging
import uuid
import time
from typing import Iterable, List, Optional, Tuple, Union

from requests.exceptions import RequestException

MAX_QDRANT_TIMEOUT = 60
MIN_QDRANT_TIMEOUT = 1

try:
    from colored_logger import get_logger
    logger = get_logger(__name__)
except ImportError:
    logger = logging.getLogger(__name__)

try:
    from qdrant_client import QdrantClient
    from qdrant_client.models import (
        Distance,
        FieldCondition,
        Filter,
        MatchAny,
        MatchValue,
        PointIdsList,
        PointStruct,
        Modifier,
        SparseIndexParams,
        SparseVector,
        SparseVectorParams,
        VectorParams,
    )
except ImportError:  # pragma: no cover - handled in health checks
    QdrantClient = None
    Distance = None
    VectorParams = None
    PointStruct = None
    Modifier = None
    SparseIndexParams = None
    SparseVector = None
    SparseVectorParams = None
    PointIdsList = None
    FieldCondition = None
    Filter = None
    MatchAny = None
    MatchValue = None
    logger.error(
        "qdrant-client is not installed. Install with: pip install qdrant-client>=1.7.0"
    )
except Exception:  # pragma: no cover - handled in health checks
    QdrantClient = None
    Distance = None
    VectorParams = None
    PointStruct = None
    Modifier = None
    SparseIndexParams = None
    SparseVector = None
    SparseVectorParams = None
    PointIdsList = None
    FieldCondition = None
    Filter = None
    MatchAny = None
    MatchValue = None


class QdrantService:
    def __init__(
        self,
        # Who: Tim Buglaev
        # When: 2026-06-14
        # What: Use IPv4 loopback so DNS/IPv6 cannot split local Qdrant reads and writes.
        url: str = "http://127.0.0.1:6333",
        collection_name: str = "notes",
        client: Optional[object] = None,
        timeout: float = 15.0,
        max_retries: int = 3,
        retry_delay: float = 1.0,
    ):
        self.url = url
        self.collection_name = collection_name
        self.lexical_collection_name = f"{collection_name}_lexical"
        self.lexical_enabled = False
        self.timeout = self._sanitize_timeout(timeout)
        self.max_retries = max(1, int(max_retries or 1))
        try:
            delay_value = float(retry_delay)
            self.retry_delay = delay_value if delay_value > 0 else 0.0
        except Exception:
            self.retry_delay = 0.0
        if client is not None:
            self.client = client
        else:
            if QdrantClient is None:
                raise ImportError(
                    "qdrant-client is not installed. Install with: pip install qdrant-client>=1.7.0"
                )
            self.client = QdrantClient(url=url, timeout=self.timeout)

    @staticmethod
    def _sanitize_timeout(timeout: Optional[float]) -> Optional[int]:
        """
        Ensures timeout is an integer value accepted by qdrant-client.
        Returns None when timeout is invalid or not provided.
        """
        try:
            if timeout is None:
                return None
            parsed = int(float(timeout))
            if parsed <= 0:
                return None
            return min(MAX_QDRANT_TIMEOUT, max(MIN_QDRANT_TIMEOUT, parsed))
        except (TypeError, ValueError):
            return None

    def _call_with_timeout(self, func, timeout_override=None, **kwargs):
        """
        Execute a Qdrant client call with timeout if supported by the client version.
        Some client versions do not accept per-call timeout kwarg, so gracefully
        retry without it on TypeError/ValueError.
        """
        timeout_value = self._sanitize_timeout(timeout_override if timeout_override is not None else self.timeout)
        try:
            if timeout_value is not None:
                return func(timeout=timeout_value, **kwargs)
            return func(**kwargs)
        except Exception as exc:
            if "timeout" in str(exc).lower():
                return func(**kwargs)
            raise

    def _retry_operation(self, operation, *args, suppress=False, backoff=False, return_error=False, **kwargs):
        """
        Execute an operation with retry logic.

        Args:
            operation: Function to execute
            *args, **kwargs: Arguments to pass to the operation
            suppress: When True, do not raise on failure and return None instead
            backoff: When True, double the delay between attempts
            return_error: When True, return a tuple of (result, last_exception)

        Returns:
            Result of the operation

        Raises:
            Last exception if all retries fail
        """
        attempts = max(1, int(self.max_retries or 1))
        delay = self.retry_delay or 0
        last_exception = None
        for attempt in range(1, attempts + 1):
            try:
                result = operation(*args, **kwargs)
                return (result, None) if return_error else result
            except Exception as exc:
                last_exception = exc
                exc_str = str(exc).lower()
                is_retryable = (
                    isinstance(exc, (TimeoutError, ConnectionError, RequestException)) or
                    'timeout' in exc_str or
                    'timed out' in exc_str or
                    'connection' in exc_str
                )

                if is_retryable:
                    if attempt < attempts:
                        sleep_seconds = delay * (2 ** (attempt - 1) if backoff and delay else 1)
                        if sleep_seconds > 0:
                            time.sleep(sleep_seconds)
                else:
                    # For non-retryable exceptions, fail immediately
                    if suppress:
                        return (None, exc) if return_error else None
                    raise
        if last_exception:
            if suppress:
                return (None, last_exception) if return_error else None
            raise last_exception
        return (None, None) if return_error else None

    # Who: Tim Buglaev
    # When: 2026-06-22
    # What: Initialize backward-compatible dense storage plus a separate sparse lexical
    #       collection, avoiding destructive migration of existing Qdrant data.
    def initialize_collection(self, vector_size: int = 768):
        """
        Creates a collection if it does not exist.
        Includes retry logic for handling transient connection issues.
        """
        if not self.client:
            raise RuntimeError("Qdrant client is not configured")

        logger.info("Initializing Qdrant collection '%s' (vector_size=%d)...", self.collection_name, vector_size)

        try:
            def _init_logic():
                collections = self._call_with_timeout(getattr(self.client, "get_collections")).collections
                existing = [c.name for c in collections]
                if self.collection_name not in existing:
                    logger.info("Collection '%s' not found, creating...", self.collection_name)
                    self._call_with_timeout(
                        getattr(self.client, "create_collection"),
                        collection_name=self.collection_name,
                        vectors_config=VectorParams(size=vector_size, distance=Distance.COSINE),
                    )
                    logger.info("Collection '%s' created successfully", self.collection_name)
                else:
                    logger.info("Collection '%s' already exists", self.collection_name)

                # Who: Tim Buglaev
                # When: 2026-06-22
                # What: Add sparse retrieval without destructively migrating the dense collection.
                if self.lexical_collection_name not in existing:
                    if SparseVectorParams is None or Modifier is None:
                        raise RuntimeError("Qdrant sparse vector API is not available")
                    sparse_params = SparseVectorParams(
                        modifier=Modifier.IDF,
                        index=SparseIndexParams(on_disk=False) if SparseIndexParams is not None else None,
                    )
                    self._call_with_timeout(
                        getattr(self.client, "create_collection"),
                        collection_name=self.lexical_collection_name,
                        vectors_config={},
                        sparse_vectors_config={"lexical": sparse_params},
                    )
                    logger.info("Collection '%s' created successfully", self.lexical_collection_name)
                self.lexical_enabled = True

            self._retry_operation(_init_logic)

        except (TimeoutError, ConnectionError, RequestException) as exc:
            logger.error("Failed to initialize Qdrant collection due to timeout/connection: %s", exc)
            raise
        except Exception as exc:
            logger.error("Failed to initialize Qdrant collection: %s", exc)
            raise

    # Who: Tim Buglaev
    # When: 2026-06-22
    # What: Accept legacy dense records and optional sparse vectors; hybrid chunks are
    #       committed to both collections while existing callers remain compatible.
    def upsert_notes(self, notes: Iterable[Tuple[Union[int, str], List[float], dict]]):
        """
        Upserts a batch of notes: iterable of (id, vector, metadata).
        """
        if not notes:
            return
        points = []
        lexical_points = []
        for record in notes:
            if not isinstance(record, (tuple, list)) or len(record) not in (3, 4):
                raise ValueError("Qdrant note record must contain id, vector, payload, and optional sparse vector")
            note_id, vector, metadata = record[:3]
            sparse_data = record[3] if len(record) == 4 else None
            if PointStruct is None:
                raise ImportError("qdrant-client is not installed")
            safe_id = note_id
            if isinstance(note_id, str):
                try:
                    uuid.UUID(note_id)
                except ValueError:
                    safe_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, note_id))
                    logger.warning("Converted string note_id '%s' to UUID %s for Qdrant", note_id, safe_id)
            elif not isinstance(note_id, int):
                safe_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, str(note_id)))
                logger.warning("Coerced non-string note_id %r to UUID %s for Qdrant", note_id, safe_id)
            points.append(PointStruct(id=safe_id, vector=vector, payload=metadata))
            if sparse_data and self.lexical_enabled:
                lexical_points.append(
                    PointStruct(
                        id=safe_id,
                        vector={
                            "lexical": SparseVector(
                                indices=list(sparse_data.get("indices") or []),
                                values=list(sparse_data.get("values") or []),
                            )
                        },
                        payload=metadata,
                    )
                )
        self._call_with_timeout(getattr(self.client, "upsert"), collection_name=self.collection_name, points=points)
        if lexical_points:
            self._call_with_timeout(
                getattr(self.client, "upsert"),
                collection_name=self.lexical_collection_name,
                points=lexical_points,
            )

    # Who: Tim Buglaev
    # When: 2026-06-22
    # What: Delete point IDs from both derived indexes when lexical storage is active,
    #       preventing stale sparse matches after note updates or removals.
    def delete_notes(self, note_ids: Iterable[Union[int, str]]):
        """Deletes points by ids to keep ANN index in sync with filesystem."""
        ids = [nid for nid in (note_ids or [])]
        if not ids:
            return
        # Who: Tim Buglaev
        # When: 2026-06-13
        # What: Use the typed Qdrant PointIdsList selector for point deletion because recent
        #       qdrant-client versions reject raw dict selectors and would leave stale notes indexed.
        selector = PointIdsList(points=ids) if PointIdsList is not None else {"points": ids}
        self._call_with_timeout(
            getattr(self.client, "delete"),
            collection_name=self.collection_name,
            points_selector=selector,
        )
        if self.lexical_enabled:
            self._call_with_timeout(
                getattr(self.client, "delete"),
                collection_name=self.lexical_collection_name,
                points_selector=selector,
            )

    # Who: Tim Buglaev
    # When: 2026-06-22
    # What: Delete every chunk belonging to parent notes through a typed payload filter;
    #       this covers unknown chunk counts after restarts and prevents orphaned evidence.
    def delete_note_chunks(self, note_ids: Iterable[Union[int, str]]):
        ids = [str(note_id) for note_id in (note_ids or []) if str(note_id or "").strip()]
        if not ids:
            return
        if Filter is None or FieldCondition is None:
            raise RuntimeError("qdrant-client payload filter API is not available")
        if MatchAny is not None:
            match = MatchAny(any=ids)
            selector = Filter(must=[FieldCondition(key="note_id", match=match)])
            self._call_with_timeout(
                getattr(self.client, "delete"),
                collection_name=self.collection_name,
                points_selector=selector,
            )
            if self.lexical_enabled:
                self._call_with_timeout(
                    getattr(self.client, "delete"),
                    collection_name=self.lexical_collection_name,
                    points_selector=selector,
                )
            return
        if MatchValue is None:
            raise RuntimeError("qdrant-client match API is not available")
        for note_id in ids:
            selector = Filter(
                must=[FieldCondition(key="note_id", match=MatchValue(value=note_id))]
            )
            self._call_with_timeout(
                getattr(self.client, "delete"),
                collection_name=self.collection_name,
                points_selector=selector,
            )
            if self.lexical_enabled:
                self._call_with_timeout(
                    getattr(self.client, "delete"),
                    collection_name=self.lexical_collection_name,
                    points_selector=selector,
                )

    # Who: Tim Buglaev
    # When: 2026-06-14
    # What: Added a bounded scroll wrapper so the app can reconcile Qdrant with the
    #       active vault and delete stale points instead of only filtering them after search.
    def scroll_points(self, limit: int = 100, offset=None, with_payload: bool = True, with_vectors: bool = False):
        scroll = getattr(self.client, "scroll", None)
        if not callable(scroll):
            raise RuntimeError("qdrant-client scroll API is not available")
        safe_limit = self._sanitize_top_k(limit, default=100)
        return self._call_with_timeout(
            scroll,
            collection_name=self.collection_name,
            limit=safe_limit,
            offset=offset,
            with_payload=with_payload,
            with_vectors=with_vectors,
        )

    @staticmethod
    def _sanitize_top_k(top_k: Union[int, float, str], default: int = 5) -> int:
        """
        Coerces the requested top_k into a positive integer accepted by Qdrant.
        Falls back to the provided default on invalid input.
        """
        try:
            parsed = int(float(top_k))
        except (TypeError, ValueError):
            parsed = default
        return parsed if parsed > 0 else default

    def search_similar(self, query_vector: List[float], top_k: int = 5):
        if not query_vector:
            return []
        limit_value = self._sanitize_top_k(top_k, default=5)

        # Who: Tim Buglaev
        # When: 2026-06-13
        # What: Support both old qdrant-client.search and new qdrant-client.query_points
        #       APIs so live RAG search uses Qdrant instead of silently falling back to cache.
        def _search_call():
            legacy_search = getattr(self.client, "search", None)
            if callable(legacy_search):
                return self._call_with_timeout(
                    legacy_search,
                    collection_name=self.collection_name,
                    query_vector=query_vector,
                    limit=limit_value,
                )

            query_points = getattr(self.client, "query_points", None)
            if callable(query_points):
                response = self._call_with_timeout(
                    query_points,
                    collection_name=self.collection_name,
                    query=query_vector,
                    limit=limit_value,
                    with_payload=True,
                    with_vectors=False,
                )
                return getattr(response, "points", response)

            return self._call_with_timeout(
                getattr(self.client, "search"),
                collection_name=self.collection_name,
                query_vector=query_vector,
                limit=limit_value,
            )

        result, last_error = self._retry_operation(
            _search_call,
            suppress=True,
            backoff=True,
            return_error=True,
        )
        if last_error:
            logger.warning(
                "Qdrant search failed after %d attempt(s): %s",
                max(1, int(self.max_retries or 1)),
                last_error,
            )
            return None
        return result

    # Who: Tim Buglaev
    # When: 2026-06-23
    # What: Fuse object/mapping points without losing payloads; lexical failure uses dense search.
    def search_hybrid(self, query_vector, sparse_data, top_k=5):
        limit_value = self._sanitize_top_k(top_k, default=5)
        dense_results = self.search_similar(query_vector, top_k=limit_value)
        if dense_results is None or not self.lexical_enabled or not sparse_data:
            return dense_results
        query_points = getattr(self.client, "query_points", None)
        if not callable(query_points) or SparseVector is None:
            return dense_results
        try:
            lexical_response = self._call_with_timeout(
                query_points,
                collection_name=self.lexical_collection_name,
                query=SparseVector(
                    indices=list(sparse_data.get("indices") or []),
                    values=list(sparse_data.get("values") or []),
                ),
                using="lexical",
                limit=limit_value,
                with_payload=True,
                with_vectors=False,
            )
            lexical_results = list(getattr(lexical_response, "points", lexical_response) or [])
        except Exception as exc:
            logger.warning("Qdrant lexical search unavailable; using dense ranking (%s)", type(exc).__name__)
            return dense_results

        fused = {}
        for result_set in (list(dense_results or []), lexical_results):
            for rank, item in enumerate(result_set, start=1):
                is_mapping = isinstance(item, dict)
                item_id = item.get("id") if is_mapping else getattr(item, "id", None)
                if item_id is None:
                    continue
                point_id = str(item_id)
                payload = (item.get("payload") if is_mapping else getattr(item, "payload", {})) or {}
                entry = fused.setdefault(
                    point_id,
                    {"id": item_id, "payload": payload, "score": 0.0},
                )
                entry["score"] += 1.0 / (60.0 + rank)
                if not entry["payload"]:
                    entry["payload"] = payload
        return sorted(fused.values(), key=lambda item: (-item["score"], str(item["id"])))[:limit_value]

    def health_check(self) -> bool:
        # Who: Tim Buglaev
        # When: 2026-06-22
        # What: Log safe Qdrant failures for diagnosis without exposing request payloads.
        try:
            self._call_with_timeout(getattr(self.client, "get_collections"))
            return True
        except (TimeoutError, ConnectionError, RequestException) as exc:
            logger.warning("Qdrant health check failed or timed out: %s", exc)
            return False
        except Exception as exc:
            logger.warning("Qdrant health check failed (%s): %s", type(exc).__name__, exc)
            return False
