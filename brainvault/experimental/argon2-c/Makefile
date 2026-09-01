CC := clang
ARGON2 := vendor/argon2
CFLAGS := -std=c11 -O3 -flto -mcpu=native -pthread -D_DARWIN_C_SOURCE -D__SSE2__ \
	-Icompat -Ivendor/sse2neon -I$(ARGON2)/include -I$(ARGON2)/src
PREBUILD_CFLAGS := -std=c11 -O3 -flto -mcpu=apple-m1 -pthread -D_DARWIN_C_SOURCE -D__SSE2__ \
	-Icompat -Ivendor/sse2neon -I$(ARGON2)/include -I$(ARGON2)/src
PREBUILD := ../../prebuilds/darwin-arm64/brainvault-argon2
PREBUILD_M3_CFLAGS := -std=c11 -O3 -flto -mcpu=native -pthread -D_DARWIN_C_SOURCE -D__SSE2__ \
	-Icompat -Ivendor/sse2neon -I$(ARGON2)/include -I$(ARGON2)/src
PREBUILD_M3 := ../../prebuilds/darwin-arm64/brainvault-argon2-m3
SOURCES := brainvault_argon2.c \
	$(ARGON2)/src/argon2.c \
	$(ARGON2)/src/core.c \
	$(ARGON2)/src/blake2/blake2b.c \
	$(ARGON2)/src/thread.c \
	$(ARGON2)/src/encoding.c \
	$(ARGON2)/src/opt.c

.PHONY: all prebuild prebuild-m3 clean

all: brainvault-argon2

brainvault-argon2: $(SOURCES) compat/emmintrin.h vendor/sse2neon/sse2neon.h
	$(CC) $(CFLAGS) $(SOURCES) -o $@

prebuild: $(PREBUILD)

# Release artifact for M3-family Macs. Build this target only on an M3 host;
# runtime selection checks the CPU model before executing it.
prebuild-m3: $(PREBUILD_M3)

$(PREBUILD): $(SOURCES) compat/emmintrin.h vendor/sse2neon/sse2neon.h
	mkdir -p $(dir $(PREBUILD))
	$(CC) $(PREBUILD_CFLAGS) $(SOURCES) -o $@

$(PREBUILD_M3): $(SOURCES) compat/emmintrin.h vendor/sse2neon/sse2neon.h
	mkdir -p $(dir $(PREBUILD_M3))
	$(CC) $(PREBUILD_M3_CFLAGS) $(SOURCES) -o $@

clean:
	rm -f brainvault-argon2 $(PREBUILD) $(PREBUILD_M3)
