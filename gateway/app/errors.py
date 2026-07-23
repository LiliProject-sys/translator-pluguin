from fastapi import HTTPException


def error_payload(error_code: str, message: str, requires_configuration: bool = False, request_id: str = "") -> dict:
    payload = {
        "status": "error",
        "errorCode": error_code,
        "message": message,
        "requiresConfiguration": requires_configuration,
    }
    if request_id:
        payload["requestId"] = request_id
    return payload


def gateway_error(
    status_code: int,
    error_code: str,
    message: str,
    requires_configuration: bool = False,
    request_id: str = "",
) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail=error_payload(error_code, message, requires_configuration, request_id),
    )
