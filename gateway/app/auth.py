import hmac
from typing import Optional

from fastapi import Header

from .config import settings
from .errors import gateway_error


def extract_bearer_token(authorization: Optional[str]) -> str:
    if not authorization:
        raise gateway_error(401, "INVALID_ACCESS_TOKEN", "测试访问码无效", True)
    parts = authorization.strip().split()
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        raise gateway_error(401, "INVALID_ACCESS_TOKEN", "测试访问码无效", True)
    return parts[1].strip()


def verify_token_value(token: str) -> None:
    configured_token = settings.beta_access_token
    if not configured_token or not hmac.compare_digest(token, configured_token):
        raise gateway_error(401, "INVALID_ACCESS_TOKEN", "测试访问码无效", True)


def require_beta_token(authorization: Optional[str] = Header(default=None)) -> str:
    token = extract_bearer_token(authorization)
    verify_token_value(token)
    return token
