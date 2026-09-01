CC := clang
ARGON2 := vendor/argon2
CFLAGS := -std=c11 -O3 -flto -mcpu=native -pthread -D_DARWIN_C_SOURCE -D__SSE2__ \
	-Icompat -Ivendor/sse2neon -I$(ARGON2)/include -I$(ARGON2)/src
SOURCES := brainvault_argon2.c \
	$(ARGON2)/src/argon2.c \
	$(ARGON2)/src/core.c \
	$(ARGON2)/src/blake2/blake2b.c \
	$(ARGON2)/src/thread.c \
	$(ARGON2)/src/encoding.c \
	$(ARGON2)/src/opt.c

.PHONY: all clean

all: brainvault-argon2

brainvault-argon2: $(SOURCES) compat/emmintrin.h vendor/sse2neon/sse2neon.h
	$(CC) $(CFLAGS) $(SOURCES) -o $@

clean:
	rm -f brainvault-argon2
