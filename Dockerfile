# 阶段 1：构建前端（React + Vite + shadcn/ui）
FROM --platform=$BUILDPLATFORM node:22-alpine AS frontend

WORKDIR /src

COPY webui/package.json webui/package-lock.json ./
RUN npm ci

COPY webui/ ./
RUN npm run build

# 阶段 2：构建 Go 后端（embed 前端产物）
FROM --platform=$BUILDPLATFORM golang:1.25 AS builder

WORKDIR /src

ENV CGO_ENABLED=0 GOWORK=off

ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=$GOPROXY

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# 将前端构建产物复制到 embed 目录。
RUN rm -rf internal/entry/web/static/* 2>/dev/null || true
COPY --from=frontend /src/dist ./internal/entry/web/static/

ARG TARGETOS
ARG TARGETARCH

RUN GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" \
    -o /out/ainovel-cli \
    ./cmd/ainovel-cli

# 阶段 3：精简运行时
FROM alpine:3.22

RUN apk add --no-cache \
    ca-certificates \
    tzdata

WORKDIR /workspace

COPY --from=builder /out/ainovel-cli /usr/local/bin/ainovel-cli

EXPOSE 5269

ENV AINOVEL_WEB_PORT=5269 \
    AINOVEL_BOOKS_DIR=/workspace/books

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5269/api/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["ainovel-cli"]
CMD ["web"]
