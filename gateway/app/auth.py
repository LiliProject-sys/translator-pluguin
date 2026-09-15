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
    matched = False
    try:
        supplied = token.encode("utf-8")
        for configured in settings.valid_access_tokens:
            # Compare every allowlisted value; Unicode input must never cause 500.
            matched |= hmac.compare_digest(supplied, configured.encode("utf-8"))
    except UnicodeError:
        matched = False
    if not matched:
        raise gateway_error(401, "INVALID_ACCESS_TOKEN", "测试访问码无效", True)


def require_beta_token(authorization: Optional[str] = Header(default=None)) -> str:
    token = extract_bearer_token(authorization)
    verify_token_value(token)
    return token
