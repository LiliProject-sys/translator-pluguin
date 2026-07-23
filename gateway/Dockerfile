FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY gateway/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY gateway ./gateway

ENV PORT=8080
CMD ["sh", "-c", "uvicorn gateway.app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
