FROM --platform=$BUILDPLATFORM golang:1.25 AS builder

WORKDIR /src

ENV CGO_ENABLED=0 GOWORK=off

ARG TARGETOS
ARG TARGETARCH

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" \
    -o /out/ainovel-cli \
    ./cmd/ainovel-cli

FROM alpine:3.22

RUN apk add --no-cache \
    ca-certificates \
    tzdata

WORKDIR /workspace

COPY --from=builder /out/ainovel-cli /usr/local/bin/ainovel-cli

# WebUI 入口端口（用户指定）；环境变量可覆盖。
EXPOSE 5269

ENV AINOVEL_WEB_PORT=5269 \
    AINOVEL_BOOKS_DIR=/workspace/books

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5269/api/health >/dev/null 2>&1 || exit 1

# 默认启动 WebUI；可用 `docker run <image> --headless ...` 等覆盖为其它模式。
ENTRYPOINT ["ainovel-cli"]
CMD ["web"]
