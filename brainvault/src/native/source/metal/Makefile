CC := clang
METAL := xcrun metal
METALLIB := xcrun metallib
ARGON2 := ../c/vendor/argon2
MACOS_MIN := 11.0
CFLAGS := -std=c11 -O3 -flto -mcpu=native -fobjc-arc -D_DARWIN_C_SOURCE -D__SSE2__ \
	-I../c/compat -I../c/vendor/sse2neon -I$(ARGON2)/include -I$(ARGON2)/src
PREBUILD_CFLAGS := -std=c11 -O3 -flto -mcpu=apple-m1 -mmacosx-version-min=$(MACOS_MIN) -fobjc-arc -D_DARWIN_C_SOURCE -D__SSE2__ \
	-I../c/compat -I../c/vendor/sse2neon -I$(ARGON2)/include -I$(ARGON2)/src
PREBUILD_BIN := ../../prebuilds/darwin-arm64/brainvault-argon2-metal
PREBUILD_LIB := ../../prebuilds/darwin-arm64/argon2.metallib
SOURCES := brainvault_argon2_metal.m \
	$(ARGON2)/src/argon2.c \
	$(ARGON2)/src/core.c \
	$(ARGON2)/src/blake2/blake2b.c \
	$(ARGON2)/src/thread.c \
	$(ARGON2)/src/encoding.c \
	$(ARGON2)/src/opt.c

.PHONY: all benchmark parity prebuild clean

all: brainvault-argon2-metal argon2.metallib

benchmark: all
	bun benchmark.ts

parity: all
	bun benchmark.ts --mode=parity --shards=2

prebuild: $(PREBUILD_BIN) $(PREBUILD_LIB)

$(PREBUILD_BIN): $(SOURCES)
	mkdir -p $(dir $@)
	$(CC) $(PREBUILD_CFLAGS) $(SOURCES) -framework Foundation -framework Metal -pthread -o $@
	codesign --remove-signature $@
	bun ../../../packaging/normalize-macho.ts $@
	codesign --force --sign - --timestamp=none $@

$(PREBUILD_LIB): argon2.air
	mkdir -p $(dir $@)
	$(METALLIB) $< -o $@

argon2.air: argon2.metal
	$(METAL) -O3 -mmacosx-version-min=$(MACOS_MIN) -c $< -o $@

argon2.metallib: argon2.air
	$(METALLIB) $< -o $@

brainvault-argon2-metal: $(SOURCES)
	$(CC) $(CFLAGS) $(SOURCES) -framework Foundation -framework Metal -pthread -o $@

clean:
	rm -f brainvault-argon2-metal argon2.air argon2.metallib $(PREBUILD_BIN) $(PREBUILD_LIB)
