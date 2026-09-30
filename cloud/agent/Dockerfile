FROM python:3.12.12-slim-bookworm
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY cloud/agent/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY core ./core
COPY data/commentary-styles.v1.json ./data/commentary-styles.v1.json
COPY data/basketball-tactics.v1.json ./data/basketball-tactics.v1.json
COPY data/broadcast-pronunciation.v1.json ./data/broadcast-pronunciation.v1.json
COPY cloud/agent/main.py ./main.py
EXPOSE 8080
USER 10001:10001
CMD ["python", "main.py"]
