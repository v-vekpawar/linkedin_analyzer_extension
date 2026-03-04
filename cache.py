"""
LinkedIn Profile Analyzer — Caching Layer
==========================================
Provides cache lookup, storage, and cleanup for LLM analysis results.
All cached analyses expire after CACHE_TTL_DAYS (28 days).
"""

import hashlib
import json
import logging
from datetime import datetime

from models import db, AnalysisCache, CACHE_TTL_DAYS

logger = logging.getLogger(__name__)


def _hash_url(profile_url: str) -> str:
    """SHA-256 hash of a profile URL, used as the cache key."""
    return hashlib.sha256(profile_url.strip().lower().encode()).hexdigest()


def get_cached_analysis(profile_url: str) -> dict | None:
    """
    Look up a cached analysis by profile URL.
    Returns the result dict if a valid (non-expired) cache entry exists,
    otherwise returns None.
    Expired entries are lazily deleted on lookup.
    """
    url_hash = _hash_url(profile_url)

    entry = AnalysisCache.query.filter_by(profile_url_hash=url_hash).first()
    if entry is None:
        return None

    # Lazy expiration — delete stale row and treat as miss
    if entry.is_expired:
        logger.info("Cache expired for %s — removing", entry.profile_name)
        db.session.delete(entry)
        db.session.commit()
        return None

    logger.info("Cache HIT for %s", entry.profile_name)
    return entry.to_result_dict()


def store_analysis(
    profile_url: str,
    profile_name: str,
    about_profile: dict,
    approach_person: dict,
    compatibility_score: dict | None,
    user_id: str | None,
    model: str,
) -> None:
    """
    Store (or overwrite) a cached analysis result for a profile URL.
    If an existing row exists for this URL, it is replaced.
    """
    url_hash = _hash_url(profile_url)

    try:
        # Upsert: delete old entry if exists, then insert fresh
        existing = AnalysisCache.query.filter_by(profile_url_hash=url_hash).first()
        if existing:
            db.session.delete(existing)
            db.session.flush()

        entry = AnalysisCache(
            profile_url_hash=url_hash,
            profile_name=profile_name,
            about_profile=json.dumps(about_profile),
            approach_person=json.dumps(approach_person),
            compatibility_score=json.dumps(compatibility_score) if compatibility_score else None,
            user_id=user_id,
            model=model,
        )
        db.session.add(entry)
        db.session.commit()
        logger.info("Cached analysis for %s (hash=%s…)", profile_name, url_hash[:12])

    except Exception as e:
        db.session.rollback()
        logger.exception("Failed to cache analysis for %s: %s", profile_name, e)
        # Cache write failure is non-fatal — caller should continue normally


def invalidate_user_cache(user_id: str) -> int:
    """
    Delete all cache entries associated with a given user_id.
    Called when a user updates their profile so compatibility scores are refreshed.
    Returns the number of rows deleted.
    """
    try:
        count = AnalysisCache.query.filter_by(user_id=user_id).delete()
        db.session.commit()
        logger.info("Invalidated %d cache entries for user %s", count, user_id)
        return count
    except Exception as e:
        db.session.rollback()
        logger.exception("Failed to invalidate cache for user %s: %s", user_id, e)
        return 0


def cleanup_expired() -> int:
    """
    Bulk-delete all expired cache entries.
    Can be called on app startup or periodically.
    Returns the number of rows deleted.
    """
    try:
        now = datetime.utcnow()
        count = AnalysisCache.query.filter(AnalysisCache.expires_at < now).delete()
        db.session.commit()
        logger.info("Cleaned up %d expired cache entries", count)
        return count
    except Exception as e:
        db.session.rollback()
        logger.exception("Failed to cleanup expired cache: %s", e)
        return 0
