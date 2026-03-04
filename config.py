import os

FLASK_ENV = os.getenv("FLASK_ENV", "production")
FLASK_DEBUG = os.getenv("FLASK_DEBUG", "False").lower() == "true"

# ── Database ──
SQLALCHEMY_DATABASE_URI = os.getenv(
    "DATABASE_URL",
    "sqlite:///linkedin_analyzer.db"     # instance-relative path
)
SQLALCHEMY_TRACK_MODIFICATIONS = False
