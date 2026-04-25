FROM python:3.12-slim

RUN pip install --no-cache-dir \
    structlog==25.4.0 \
    "websockets>=15.0.1" \
    "python-dotenv>=1.1.1" \
    "numpy>=2.0" \
    "pyyaml>=6.0"

WORKDIR /srv

COPY app /srv/app
COPY handlers /srv/handlers
# /srv/prompts is bind-mounted from voice-stack/prompts at runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/srv \
    SIP_HOST=127.0.0.1 \
    SIP_PORT=5080 \
    HANGUP_AFTER=60 \
    RUNS_DIR=/srv/runs \
    HANDLER=etappe_b_dummy

# Shell form so $HANDLER expands at container start.
ENTRYPOINT ["/bin/sh", "-c"]
CMD ["exec python -u -m handlers.${HANDLER}"]
