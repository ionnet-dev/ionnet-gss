VERSION ?= 0.1.0
LDFLAGS := -s -w -X github.com/ionnet-dev/ionnet-gss/agent/internal/version.Version=$(VERSION)
# Hosts are Linux; gss-init runs in the (linux) game containers.
TARGETS := linux/amd64 linux/arm64
DIST ?= dist

.PHONY: build run test vet lint clean dist

build:
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/gss-agent ./cmd/gss-agent
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/gss-init ./cmd/gss-init

run: build
	./bin/gss-agent $(ARGS)

test:
	go test ./...

vet:
	go vet ./...

lint: vet
	@test -z "$$(gofmt -l .)" || (gofmt -l . && exit 1)

# Every target, as dist/<binary>-linux-<arch> with .sha256 sidecars and a VERSION file.
dist:
	mkdir -p $(DIST)
	@for t in $(TARGETS); do \
		os=$${t%%/*}; arch=$${t#*/}; \
		for bin in gss-agent gss-init; do \
			echo "building $$bin $$os/$$arch"; \
			CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -trimpath -ldflags "$(LDFLAGS)" -o $(DIST)/$$bin-$$os-$$arch ./cmd/$$bin || exit 1; \
			sha256sum $(DIST)/$$bin-$$os-$$arch | cut -d' ' -f1 > $(DIST)/$$bin-$$os-$$arch.sha256; \
		done; \
	done
	echo "$(VERSION)" > $(DIST)/VERSION

clean:
	rm -rf bin dist
