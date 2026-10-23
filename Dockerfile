# syntax=docker/dockerfile:1

FROM node:24-slim AS web
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/web/ ./
RUN npm run build

FROM python:3.13-slim AS app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    THULE_STATIC_DIR=/app/static
WORKDIR /app
COPY apps/api/pyproject.toml ./
COPY apps/api/app ./app
RUN pip install .
COPY apps/api/alembic.ini ./
COPY apps/api/migrations ./migrations
COPY --from=web /web/dist ./static
RUN useradd --system --uid 10001 thule
USER thule
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health')"
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*'"]
