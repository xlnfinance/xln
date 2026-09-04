CC := clang
ARGON2 := vendor/argon2
MACOS_MIN := 11.0
CFLAGS := -std=c11 -O3 -flto -mcpu=native -pthread -D_DARWIN_C_SOURCE -D__SSE2__ \
	-Icompat -Ivendor/sse2neon -I$(ARGON2)/include -I$(ARGON2)/src
PREBUILD_CFLAGS := -std=c11 -O3 -flto -mcpu=apple-m1 -mmacosx-version-min=$(MACOS_MIN) -pthread -D_DARWIN_C_SOURCE -D__SSE2__ \
	-Icompat -Ivendor/sse2neon -I$(ARGON2)/include -I$(ARGON2)/src
PREBUILD := ../../prebuilds/darwin-arm64/brainvault-argon2
PREBUILD_M3_CFLAGS := -std=c11 -O3 -flto -mcpu=apple-m3 -mmacosx-version-min=$(MACOS_MIN) -pthread -D_DARWIN_C_SOURCE -D__SSE2__ \
	-Icompat -Ivendor/sse2neon -I$(ARGON2)/include -I$(ARGON2)/src
PREBUILD_M3 := ../../prebuilds/darwin-arm64/brainvault-argon2-m3
SOURCES := brainvault_argon2.c \
	$(ARGON2)/src/argon2.c \
	$(ARGON2)/src/core.c \
	$(ARGON2)/src/blake2/blake2b.c \
	$(ARGON2)/src/thread.c \
	$(ARGON2)/src/encoding.c \
	$(ARGON2)/src/opt.c
HEADERS := compat/emmintrin.h vendor/sse2neon/sse2neon.h \
	$(ARGON2)/include/argon2.h $(ARGON2)/src/core.h \
	$(ARGON2)/src/encoding.h $(ARGON2)/src/thread.h \
	$(ARGON2)/src/blake2/blake2.h $(ARGON2)/src/blake2/blake2-impl.h \
	$(ARGON2)/src/blake2/blamka-round-opt.h $(ARGON2)/src/blake2/blamka-round-ref.h

.PHONY: all oversubscribed prebuild prebuild-m3 clean

all: brainvault-argon2

oversubscribed: brainvault-argon2-oversubscribed

brainvault-argon2-oversubscribed: $(SOURCES) $(HEADERS)
	$(CC) $(CFLAGS) -DBRAINVAULT_MAX_WORKERS=64u $(SOURCES) -o $@

brainvault-argon2: $(SOURCES) $(HEADERS)
	$(CC) $(CFLAGS) $(SOURCES) -o $@

prebuild: $(PREBUILD)

# Release artifact for M3-family Macs. Build this target only on an M3 host;
# runtime selection checks the CPU model before executing it.
prebuild-m3: $(PREBUILD_M3)

$(PREBUILD): $(SOURCES) $(HEADERS)
	mkdir -p $(dir $(PREBUILD))
	$(CC) $(PREBUILD_CFLAGS) $(SOURCES) -o $@
	codesign --remove-signature $@
	bun ../../../packaging/normalize-macho.ts $@
	codesign --force --sign - --timestamp=none $@

$(PREBUILD_M3): $(SOURCES) $(HEADERS)
	mkdir -p $(dir $(PREBUILD_M3))
	$(CC) $(PREBUILD_M3_CFLAGS) $(SOURCES) -o $@
	codesign --remove-signature $@
	bun ../../../packaging/normalize-macho.ts $@
	codesign --force --sign - --timestamp=none $@

clean:
	rm -f brainvault-argon2 brainvault-argon2-oversubscribed $(PREBUILD) $(PREBUILD_M3)
