"""
LinkedIn Profile Analyzer — Database Models
=============================================
SQLAlchemy models for user profiles and analysis caching.
"""

from datetime import datetime, timedelta, timezone
from flask_sqlalchemy import SQLAlchemy
import json

db = SQLAlchemy()

# ── Cache expiration constant ──
CACHE_TTL_DAYS = 28


class UserProfile(db.Model):
    """Stores the extension user's own LinkedIn profile for compatibility scoring."""

    __tablename__ = "user_profiles"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    user_id = db.Column(db.String(36), unique=True, nullable=False, index=True)
    name = db.Column(db.String(255), nullable=False)
    headline = db.Column(db.Text, default="")
    about = db.Column(db.Text, default="")
    experience = db.Column(db.Text, default="[]")          # JSON-serialized
    skills = db.Column(db.Text, default="[]")               # JSON-serialized
    education = db.Column(db.Text, default="[]")            # JSON-serialized
    certifications = db.Column(db.Text, default="[]")       # JSON-serialized
    created_at = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    updated_at = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc),
                           onupdate=lambda: datetime.now(timezone.utc))

    def to_profile_dict(self):
        """Return profile data in the same shape the LLM expects."""
        return {
            "name": self.name,
            "headline": self.headline,
            "about": self.about,
            "experience": json.loads(self.experience) if self.experience else [],
            "skills": json.loads(self.skills) if self.skills else [],
            "education": json.loads(self.education) if self.education else [],
            "certifications": json.loads(self.certifications) if self.certifications else [],
        }

    def __repr__(self):
        return f"<UserProfile {self.user_id!r} ({self.name})>"


class AnalysisCache(db.Model):
    """Caches LLM analysis results per analyzed profile, with 28-day TTL."""

    __tablename__ = "analysis_cache"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    profile_url_hash = db.Column(db.String(64), unique=True, nullable=False, index=True)
    profile_name = db.Column(db.String(255), default="")
    about_profile = db.Column(db.Text, nullable=False)          # JSON-serialized
    approach_person = db.Column(db.Text, nullable=False)        # JSON-serialized
    compatibility_score = db.Column(db.Text, nullable=True)     # JSON-serialized (nullable)
    user_id = db.Column(db.String(36), nullable=True)
    model = db.Column(db.String(50), default="")
    created_at = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    expires_at = db.Column(db.DateTime, nullable=False, index=True,
                           default=lambda: datetime.now(timezone.utc) + timedelta(days=CACHE_TTL_DAYS))

    @property
    def is_expired(self):
        return datetime.now(timezone.utc) > self.expires_at

    def to_result_dict(self):
        """Deserialize cached JSON columns into a response dict."""
        result = {
            "about_profile": json.loads(self.about_profile),
            "approach_person": json.loads(self.approach_person),
            "compatibility_score": json.loads(self.compatibility_score) if self.compatibility_score else None,
            "profile_name": self.profile_name,
            "model": self.model,
            "generated_at": self.created_at.strftime("%m/%d/%Y, %I:%M:%S %p"),
            "cached": True,
        }
        return result

    def __repr__(self):
        return f"<AnalysisCache {self.profile_url_hash[:12]}… ({self.profile_name})>"
