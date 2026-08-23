ROOT := ../../..
SECP := $(ROOT)/node_modules/secp256k1/src/secp256k1
CXX ?= clang++
CC ?= clang
BUILD := build
ARCH := $(shell uname -m)

COMMON_DEFINES := \
	-DECMULT_GEN_PREC_BITS=4 \
	-DECMULT_WINDOW_SIZE=15 \
	-DENABLE_MODULE_RECOVERY=1 \
	-DUSE_ENDOMORPHISM=1 \
	-DUSE_FIELD_INV_BUILTIN=1 \
	-DUSE_NUM_NONE=1 \
	-DUSE_SCALAR_INV_BUILTIN=1

ifeq ($(ARCH),x86_64)
ARCH_DEFINES := -DHAVE___INT128=1 -DUSE_ASM_X86_64=1 -DUSE_FIELD_5X52=1 -DUSE_SCALAR_4X64=1
else
ARCH_DEFINES := -DUSE_FIELD_10X26=1 -DUSE_SCALAR_8X32=1
endif

CPPFLAGS := -I$(SECP) -I$(SECP)/include -I$(SECP)/src $(COMMON_DEFINES) $(ARCH_DEFINES)
CFLAGS := -O3 -DNDEBUG -Wall -Wextra -Wno-unused-function
CXXFLAGS := -O3 -DNDEBUG -std=c++20 -Wall -Wextra -Wpedantic

.PHONY: all run clean

all: $(BUILD)/native-account-bench

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/secp256k1.o: $(SECP)/src/secp256k1.c | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

$(BUILD)/main.o: main.cpp | $(BUILD)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -c $< -o $@

$(BUILD)/native-account-bench: $(BUILD)/main.o $(BUILD)/secp256k1.o
	$(CXX) $(CXXFLAGS) $^ -o $@

run: all
	./$(BUILD)/native-account-bench

clean:
	rm -rf $(BUILD)
