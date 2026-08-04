import os

DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite"
DEFAULT_GEMINI_TIMEOUT_SECONDS = 30
DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash"
DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEFAULT_DEEPSEEK_TIMEOUT_SECONDS = 30
DEFAULT_GATEWAY_UPSTREAM_PROVIDER = "gemini"
MAX_REQUEST_BODY_BYTES = 32 * 1024


class Settings:
    def __init__(self) -> None:
        self.beta_access_token = os.getenv("BETA_ACCESS_TOKEN", "")
        self.gemini_api_key = os.getenv("GEMINI_API_KEY", "")
        self.gemini_model = os.getenv("GEMINI_MODEL", DEFAULT_GEMINI_MODEL)
        self.deepseek_api_key = os.getenv("DEEPSEEK_API_KEY", "")
        self.deepseek_model = os.getenv("DEEPSEEK_MODEL", DEFAULT_DEEPSEEK_MODEL)
        self.deepseek_base_url = os.getenv("DEEPSEEK_BASE_URL", DEFAULT_DEEPSEEK_BASE_URL).rstrip("/")
        self.gateway_upstream_provider = (
            os.getenv("GATEWAY_UPSTREAM_PROVIDER", DEFAULT_GATEWAY_UPSTREAM_PROVIDER).strip().lower()
            or DEFAULT_GATEWAY_UPSTREAM_PROVIDER
        )
        self.port = int(os.getenv("PORT", "8080"))
        self.gemini_timeout_seconds = DEFAULT_GEMINI_TIMEOUT_SECONDS
        self.deepseek_timeout_seconds = DEFAULT_DEEPSEEK_TIMEOUT_SECONDS


settings = Settings()
