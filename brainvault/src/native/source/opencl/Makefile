CXX := clang++
CXXFLAGS ?= -O3 -DNDEBUG -std=c++11
MACOS_MIN := 11.0
PREBUILD_CXXFLAGS := $(CXXFLAGS) -mmacosx-version-min=$(MACOS_MIN)
CPPFLAGS := -Iinclude -Iinclude/argon2-gpu-common -Iinclude/argon2-opencl \
	-Ilib/argon2-gpu-common -Ilib/argon2-opencl
SOURCES := \
	brainvault_argon2_opencl.cpp \
	lib/argon2-gpu-common/argon2params.cpp \
	lib/argon2-gpu-common/blake2b.cpp \
	lib/argon2-opencl/device.cpp \
	lib/argon2-opencl/globalcontext.cpp \
	lib/argon2-opencl/kernelloader.cpp \
	lib/argon2-opencl/kernelrunner.cpp \
	lib/argon2-opencl/processingunit.cpp \
	lib/argon2-opencl/programcontext.cpp
TARGET := brainvault-argon2-opencl
PREBUILD := ../../prebuilds/darwin-arm64/brainvault-argon2-opencl
HEADERS := lib/argon2-gpu-common/securezero.h

.PHONY: all parity benchmark benchmark-fastest prebuild clean

all: $(TARGET)

$(TARGET): $(SOURCES) $(HEADERS) data/kernels/argon2_kernel.cl
	$(CXX) $(CPPFLAGS) $(PREBUILD_CXXFLAGS) $(SOURCES) -framework OpenCL -o $@

parity: $(TARGET)
	bun parity.ts 2

benchmark: $(TARGET)
	bun benchmark.ts 480 240 32 1

benchmark-fastest: $(TARGET)
	bun benchmark.ts 496 248 30 1

prebuild: $(PREBUILD)

$(PREBUILD): $(SOURCES) $(HEADERS) data/kernels/argon2_kernel.cl
	mkdir -p $(dir $@)
	$(CXX) $(CPPFLAGS) $(PREBUILD_CXXFLAGS) $(SOURCES) -framework OpenCL -o $@
	codesign --remove-signature $@
	bun ../../../packaging/normalize-macho.ts $@
	codesign --force --sign - --timestamp=none $@

clean:
	rm -f $(TARGET) $(PREBUILD)
