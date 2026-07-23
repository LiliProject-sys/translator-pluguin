import os

DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite"
DEFAULT_GEMINI_TIMEOUT_SECONDS = 30
MAX_REQUEST_BODY_BYTES = 32 * 1024


class Settings:
    def __init__(self) -> None:
        self.beta_access_token = os.getenv("BETA_ACCESS_TOKEN", "")
        self.gemini_api_key = os.getenv("GEMINI_API_KEY", "")
        self.gemini_model = os.getenv("GEMINI_MODEL", DEFAULT_GEMINI_MODEL)
        self.port = int(os.getenv("PORT", "8080"))
        self.gemini_timeout_seconds = DEFAULT_GEMINI_TIMEOUT_SECONDS


settings = Settings()
