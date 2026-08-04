from __future__ import annotations

import json

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .auth import require_beta_token
from .config import MAX_REQUEST_BODY_BYTES, settings
from .errors import error_payload, gateway_error
from .language_service import process_language_request
from .schemas import LanguageRequest
from .upstream import get_upstream_client


def create_app(upstream_client=None) -> FastAPI:
    app = FastAPI(title="translator-gateway")
    client = upstream_client or get_upstream_client(settings.gateway_upstream_provider)

    @app.middleware("http")
    async def limit_request_body(request: Request, call_next):
        if request.method in {"POST", "PUT", "PATCH"}:
            content_length = request.headers.get("content-length")
            if content_length and int(content_length) > MAX_REQUEST_BODY_BYTES:
                return JSONResponse(
                    status_code=413,
                    content=error_payload("REQUEST_TOO_LARGE", "请求体过大", False),
                )
        return await call_next(request)

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError):
        request_id = ""
        try:
            body = await request.body()
            if len(body) <= MAX_REQUEST_BODY_BYTES:
                payload = json.loads(body.decode("utf-8") or "{}")
                request_id = str(payload.get("requestId", "")).strip()
        except Exception:
            request_id = ""
        return JSONResponse(
            status_code=400,
            content=error_payload("INVALID_REQUEST", "请求字段不合法", False, request_id),
        )

    @app.exception_handler(HTTPException)
    async def http_error_handler(request: Request, exc: HTTPException):
        return JSONResponse(status_code=exc.status_code, content=exc.detail)

    @app.exception_handler(Exception)
    async def generic_error_handler(request: Request, exc: Exception):
        if hasattr(exc, "status_code") and hasattr(exc, "detail"):
            return JSONResponse(status_code=exc.status_code, content=exc.detail)
        return JSONResponse(
            status_code=500,
            content=error_payload("GATEWAY_INTERNAL_ERROR", "Gateway 内部错误", False),
        )

    @app.get("/health")
    async def health():
        return {"status": "ok", "service": "translator-gateway"}

    @app.post("/v1/auth/verify", dependencies=[Depends(require_beta_token)])
    async def verify_auth():
        return {"status": "ok", "access": "granted"}

    @app.post("/v1/language")
    async def language(payload: LanguageRequest, token: str = Depends(require_beta_token)):
        data = process_language_request(payload, client)

        return {
            "status": "ok",
            "requestId": payload.requestId,
            "data": data,
        }

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=settings.port)
