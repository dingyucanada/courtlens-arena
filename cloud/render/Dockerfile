FROM node:24.11.1-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg fonts-noto-cjk ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY requirements-cloud.txt ./
RUN pip3 install --break-system-packages --no-cache-dir -r requirements-cloud.txt
COPY core ./core
COPY data/commentary-styles.v1.json ./data/commentary-styles.v1.json
COPY data/basketball-tactics.v1.json ./data/basketball-tactics.v1.json
COPY tools ./tools
COPY pro ./pro
COPY contracts ./contracts
COPY cloud ./cloud
ENV PYTHONPATH=/app COURTLENS_NODE=node COURTLENS_BROADCAST_FONT=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
CMD ["python3", "-m", "cloud.render.runner"]
