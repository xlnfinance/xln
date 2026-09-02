CC := clang
METAL := xcrun metal
METALLIB := xcrun metallib
ARGON2 := ../argon2-c/vendor/argon2
CFLAGS := -std=c11 -O3 -flto -mcpu=native -fobjc-arc -D_DARWIN_C_SOURCE -D__SSE2__ \
	-I../argon2-c/compat -I../argon2-c/vendor/sse2neon -I$(ARGON2)/include -I$(ARGON2)/src
SOURCES := brainvault_argon2_metal.m \
	$(ARGON2)/src/argon2.c \
	$(ARGON2)/src/core.c \
	$(ARGON2)/src/blake2/blake2b.c \
	$(ARGON2)/src/thread.c \
	$(ARGON2)/src/encoding.c \
	$(ARGON2)/src/opt.c

.PHONY: all benchmark parity clean

all: brainvault-argon2-metal argon2.metallib

benchmark: all
	bun benchmark.ts

parity: all
	bun benchmark.ts --mode=parity --shards=2

argon2.air: argon2.metal
	$(METAL) -O3 -c $< -o $@

argon2.metallib: argon2.air
	$(METALLIB) $< -o $@

brainvault-argon2-metal: $(SOURCES)
	$(CC) $(CFLAGS) $(SOURCES) -framework Foundation -framework Metal -pthread -o $@

clean:
	rm -f brainvault-argon2-metal argon2.air argon2.metallib
