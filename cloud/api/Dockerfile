FROM node:24.11.1-bookworm-slim AS node-runtime

FROM python:3.12.12-slim-bookworm
WORKDIR /app
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
RUN node --version | grep -Fx 'v24.11.1'
COPY requirements-cloud.txt ./
RUN pip install --no-cache-dir -r requirements-cloud.txt awslambdaric==3.1.1
COPY core ./core
COPY data/commentary-styles.v1.json ./data/commentary-styles.v1.json
COPY data/basketball-tactics.v1.json ./data/basketball-tactics.v1.json
COPY data/broadcast-pronunciation.v1.json ./data/broadcast-pronunciation.v1.json
COPY contracts ./contracts
COPY cloud/__init__.py ./cloud/__init__.py
COPY cloud/api ./cloud/api
COPY cloud/common ./cloud/common
COPY tools/broadcast_compile.mjs ./tools/broadcast_compile.mjs
COPY pro/metrics-v2.mjs ./pro/metrics-v2.mjs
ENV PYTHONPATH=/app COURTLENS_NODE=/usr/local/bin/node
ENTRYPOINT ["python", "-m", "awslambdaric"]
CMD ["cloud.api.api.handler"]
