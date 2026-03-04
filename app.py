"""
LinkedIn Profile Analyzer — Flask API Backend
Accepts profile data as JSON from the Chrome Extension,
runs LLM analysis via Gemini, and returns structured results.
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import os, logging, json
from summarizer import analyze_profile_unified
from config import FLASK_ENV, FLASK_DEBUG, SQLALCHEMY_DATABASE_URI, SQLALCHEMY_TRACK_MODIFICATIONS
from models import db, UserProfile
from cache import get_cached_analysis, store_analysis, invalidate_user_cache, cleanup_expired
from dotenv import load_dotenv

# ──────────────────────── Logging ────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)
load_dotenv()

API_KEY = os.getenv("GEMINI_API_KEY", None)

# ──────────────── Required profile fields ────────────────
REQUIRED_FIELDS = ["name", "headline", "about", "experience",
                   "skills", "education", "certifications"]


def validate_profile_data(data):
    """Validate incoming profile JSON and return (cleaned_data, error)."""
    if not data or not isinstance(data, dict):
        return None, "Request body must be a JSON object."

    missing = [f for f in REQUIRED_FIELDS if f not in data]
    if missing:
        return None, f"Missing required fields: {', '.join(missing)}"

    # Normalise types — accept strings, lists, etc. gracefully
    cleaned = {
        "name":           str(data.get("name", "")).strip() or "Unknown",
        "headline":       str(data.get("headline", "")).strip() or "No headline",
        "about":          str(data.get("about", "")).strip() or "No about section",
        "experience":     data.get("experience", []) if isinstance(data.get("experience"), list) else [],
        "skills":         data.get("skills", [])     if isinstance(data.get("skills"), list) else [],
        "education":      data.get("education", [])  if isinstance(data.get("education"), list) else [],
        "certifications": data.get("certifications", []) if isinstance(data.get("certifications"), list) else [],
    }
    return cleaned, None


def create_flask_app():
    """Application factory."""
    app = Flask(__name__)
    app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "dev-secret-key")
    app.config["FLASK_ENV"] = FLASK_ENV
    app.config["SQLALCHEMY_DATABASE_URI"] = SQLALCHEMY_DATABASE_URI
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = SQLALCHEMY_TRACK_MODIFICATIONS

    # ── Initialize extensions ──
    db.init_app(app)

    with app.app_context():
        db.create_all()
        cleanup_expired()   # purge stale cache rows on startup

    # Allow requests from the Chrome Extension (and localhost for dev)
    CORS(app, resources={
        r"/analyze": {"origins": "*"},
        r"/save-user-profile": {"origins": "*"},
    })

    # ───────────────── Health-check ─────────────────
    @app.route("/")
    def index():
        return jsonify({
            "status": "ok",
            "message": "LinkedIn Profile Analyzer API is running.",
            "endpoints": {
                "POST /analyze": "Send profile JSON to get unified AI analysis.",
                "POST /save-user-profile": "Save your LinkedIn profile for compatibility scoring.",
            }
        })

    # ───────────────── Unified analysis endpoint ─────────────────
    @app.route("/analyze", methods=["POST"])
    def analyze():
        """
        POST /analyze
        Accepts JSON body with profile_data, profile_url, and optional user_id.
        Returns unified AI analysis (about_profile + approach_person + compatibility_score).
        """
        try:
            # ── Guard: API key must be configured ──
            if not API_KEY:
                logger.error("GEMINI_API_KEY not set")
                return jsonify({"error": "Server misconfigured — missing API key."}), 500

            data = request.get_json(silent=True)
            if data is None:
                return jsonify({"error": "Invalid or missing JSON body."}), 400

            # ── Validate target profile data ──
            profile_data, err = validate_profile_data(data.get("profile_data"))
            if err:
                return jsonify({"error": f"profile_data validation failed: {err}"}), 400

            profile_url = data.get("profile_url", "")
            user_id = data.get("user_id", "")

            # ── Cache lookup ──
            if profile_url:
                cached = get_cached_analysis(profile_url)
                if cached:
                    logger.info("Returning cached analysis for %s", profile_data["name"])
                    return jsonify(cached), 200

            # ── Resolve user profile for compatibility scoring ──
            user_data = None
            if user_id:
                user_profile = UserProfile.query.filter_by(user_id=user_id).first()
                if user_profile:
                    user_data = user_profile.to_profile_dict()
                    logger.info("User profile found for compatibility: %s", user_data["name"])

            # ── Run unified LLM analysis (single Gemini call) ──
            logger.info("Running unified analysis for %s", profile_data["name"])
            result = analyze_profile_unified(profile_data, user_data=user_data)

            if not result or result.get("error"):
                return jsonify({"error": "LLM analysis failed. Check your Gemini API key."}), 500

            # ── Store in cache (best-effort) ──
            if profile_url:
                try:
                    store_analysis(
                        profile_url=profile_url,
                        profile_name=profile_data["name"],
                        about_profile=result.get("about_profile", {}),
                        approach_person=result.get("approach_person", {}),
                        compatibility_score=result.get("compatibility_score"),
                        user_id=user_id or None,
                        model=result.get("model", ""),
                    )
                except Exception as cache_err:
                    logger.warning("Cache store failed (non-fatal): %s", cache_err)

            return jsonify(result), 200

        except Exception as e:
            logger.exception("Unhandled error in /analyze: %s", e)
            return jsonify({"error": f"Internal server error: {str(e)}"}), 500

    # ───────────────── Save user profile endpoint ─────────────────
    @app.route("/save-user-profile", methods=["POST"])
    def save_user_profile():
        """
        POST /save-user-profile
        Stores the extension user's own LinkedIn profile for compatibility scoring.
        """
        try:
            data = request.get_json(silent=True)
            if data is None:
                return jsonify({"error": "Invalid or missing JSON body."}), 400

            user_id = data.get("user_id", "").strip()
            if not user_id:
                return jsonify({"error": "user_id is required."}), 400

            # Validate user's profile data
            profile_data, err = validate_profile_data(data.get("profile_data"))
            if err:
                return jsonify({"error": f"profile_data validation failed: {err}"}), 400

            # Upsert: update if exists, create if not
            existing = UserProfile.query.filter_by(user_id=user_id).first()
            if existing:
                existing.name = profile_data["name"]
                existing.headline = profile_data["headline"]
                existing.about = profile_data["about"]
                existing.experience = json.dumps(profile_data["experience"])
                existing.skills = json.dumps(profile_data["skills"])
                existing.education = json.dumps(profile_data["education"])
                existing.certifications = json.dumps(profile_data["certifications"])
                logger.info("Updated user profile for %s (%s)", profile_data["name"], user_id)
            else:
                new_profile = UserProfile(
                    user_id=user_id,
                    name=profile_data["name"],
                    headline=profile_data["headline"],
                    about=profile_data["about"],
                    experience=json.dumps(profile_data["experience"]),
                    skills=json.dumps(profile_data["skills"]),
                    education=json.dumps(profile_data["education"]),
                    certifications=json.dumps(profile_data["certifications"]),
                )
                db.session.add(new_profile)
                logger.info("Created user profile for %s (%s)", profile_data["name"], user_id)

            db.session.commit()

            # Invalidate cached analyses for this user (compatibility scores may change)
            invalidate_user_cache(user_id)

            return jsonify({"status": "ok", "message": "Profile saved successfully."}), 200

        except Exception as e:
            db.session.rollback()
            logger.exception("Error saving user profile: %s", e)
            return jsonify({"error": f"Internal server error: {str(e)}"}), 500

    return app


# ── Module-level app instance for `flask run` / Docker / HF Spaces ──
app = create_flask_app()

if __name__ == "__main__":
    if not API_KEY:
        logger.error("GEMINI_API_KEY not set — please add it to your .env file.")
    else:
        app.run(debug=FLASK_DEBUG)
