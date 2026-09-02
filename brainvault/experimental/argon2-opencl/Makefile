CXX := clang++
CXXFLAGS ?= -O3 -DNDEBUG -std=c++11
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

.PHONY: all parity benchmark benchmark-fastest clean

all: $(TARGET)

$(TARGET): $(SOURCES) data/kernels/argon2_kernel.cl
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) $(SOURCES) -framework OpenCL -o $@

parity: $(TARGET)
	bun parity.ts 2

benchmark: $(TARGET)
	bun benchmark.ts 480 240 32 1

benchmark-fastest: $(TARGET)
	bun benchmark.ts 480 240 30 1

clean:
	rm -f $(TARGET)
