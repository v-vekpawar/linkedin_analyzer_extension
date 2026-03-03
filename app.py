"""
LinkedIn Profile Analyzer — Flask API Backend
Accepts profile data as JSON from the Chrome Extension,
runs LLM analysis via Gemini, and returns structured results.
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import os, logging
from summarizer import analyze_profile
from config import FLASK_ENV, FLASK_DEBUG
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

    # Allow requests from the Chrome Extension (and localhost for dev)
    CORS(app, resources={r"/analyze": {"origins": "*"}})

    # ───────────────── Health-check ─────────────────
    @app.route("/")
    def index():
        return jsonify({
            "status": "ok",
            "message": "LinkedIn Profile Analyzer API is running.",
            "endpoints": {
                "POST /analyze": "Send profile JSON to get AI analysis."
            }
        })

    # ───────────────── Main analysis endpoint ─────────────────
    @app.route("/analyze", methods=["POST"])
    def analyze():
        """
        POST /analyze
        Accepts JSON body with profile data + analysis_mode.
        Returns structured AI analysis.
        """
        try:
            # ── Guard: API key must be configured ──
            if not API_KEY:
                logger.error("GEMINI_API_KEY not set")
                return jsonify({"error": "Server misconfigured — missing API key."}), 500

            data = request.get_json(silent=True)
            if data is None:
                return jsonify({"error": "Invalid or missing JSON body."}), 400

            # ── Extract analysis mode ──
            analysis_mode = data.get("analysis_mode", "about_profile")
            valid_modes = ["about_profile", "approach_person", "compatibility_score"]
            if analysis_mode not in valid_modes:
                return jsonify({"error": f"Invalid analysis_mode. Must be one of: {valid_modes}"}), 400

            # ── Validate target profile data ──
            profile_data, err = validate_profile_data(data.get("profile_data"))
            if err:
                return jsonify({"error": f"profile_data validation failed: {err}"}), 400

            # ── For compatibility_score, also require user_data ──
            user_data = None
            if analysis_mode == "compatibility_score":
                user_data, u_err = validate_profile_data(data.get("user_data"))
                if u_err:
                    return jsonify({"error": f"user_data validation failed: {u_err}"}), 400

            # ── Run LLM analysis ──
            logger.info("Running analysis: mode=%s, target=%s", analysis_mode, profile_data["name"])
            if analysis_mode == "compatibility_score":
                result = analyze_profile(profile_data, analysis_mode, user_data=user_data)
            else:
                result = analyze_profile(profile_data, analysis_mode)

            if not result or result.get("error"):
                return jsonify({"error": "LLM analysis failed. Check your Gemini API key."}), 500

            return jsonify(result), 200

        except Exception as e:
            logger.exception("Unhandled error in /analyze: %s", e)
            return jsonify({"error": f"Internal server error: {str(e)}"}), 500

    return app


# ── Module-level app instance for `flask run` / Docker / HF Spaces ──
app = create_flask_app()

if __name__ == "__main__":
    if not API_KEY:
        logger.error("GEMINI_API_KEY not set — please add it to your .env file.")
    else:
        app.run(debug=FLASK_DEBUG)