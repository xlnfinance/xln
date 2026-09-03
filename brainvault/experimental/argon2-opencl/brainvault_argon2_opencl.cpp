#define __STDC_WANT_LIB_EXT1__ 1

#include "argon2-gpu-common/argon2params.h"
#include "argon2-opencl/globalcontext.h"
#include "argon2-opencl/processingunit.h"
#include "argon2-opencl/programcontext.h"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <vector>

static void secure_zero(void *pointer, std::size_t size)
{
    if (pointer == nullptr || size == 0) return;
#if defined(__APPLE__)
    (void)memset_s(pointer, size, 0, size);
#else
    volatile std::uint8_t *bytes = static_cast<volatile std::uint8_t *>(pointer);
    while (size-- != 0) *bytes++ = 0;
#endif
}

class WipeOnExit
{
private:
    std::vector<std::uint8_t> &bytes;

public:
    explicit WipeOnExit(std::vector<std::uint8_t> &bytes) : bytes(bytes) {}
    ~WipeOnExit() { secure_zero(bytes.data(), bytes.size()); }
};

static std::uint32_t read_u32le(const std::uint8_t *p)
{
    return static_cast<std::uint32_t>(p[0])
        | (static_cast<std::uint32_t>(p[1]) << 8)
        | (static_cast<std::uint32_t>(p[2]) << 16)
        | (static_cast<std::uint32_t>(p[3]) << 24);
}

static void read_exact(void *dst, std::size_t size)
{
    if (size && std::fread(dst, 1, size, stdin) != size) {
        throw std::runtime_error("truncated input");
    }
}

int main(int argc, char **argv)
try {
    (void)argv;
    if (argc != 1) throw std::runtime_error("invalid invocation");
    typedef std::chrono::steady_clock probe_clock;
    const auto started = probe_clock::now();
    std::uint8_t header[24];
    read_exact(header, sizeof(header));
    const std::uint32_t magic = read_u32le(header);
    const std::uint32_t count = read_u32le(header + 4);
    const std::uint32_t workers = read_u32le(header + 8);
    const std::uint32_t password_size = read_u32le(header + 12);
    const std::uint32_t flags = read_u32le(header + 16);
    const std::uint32_t memory_kib = read_u32le(header + 20);
    if (magic != 0x32435642u || count == 0 || workers == 0 || workers > count
            || workers > 256 || password_size == 0
            || flags != 0 || memory_kib != 262144u) {
        throw std::runtime_error("invalid V1 input");
    }

    std::vector<std::uint8_t> password(password_size);
    WipeOnExit wipe_password(password);
    std::vector<std::uint8_t> salts(static_cast<std::size_t>(count) * 32);
    WipeOnExit wipe_salts(salts);
    std::vector<std::uint8_t> outputs(static_cast<std::size_t>(count) * 32);
    WipeOnExit wipe_outputs(outputs);
    read_exact(password.data(), password.size());
    read_exact(salts.data(), salts.size());
    if (std::fgetc(stdin) != EOF || std::ferror(stdin)) {
        throw std::runtime_error("trailing input");
    }

    std::size_t requested_batch = workers;
    if (const char *batch_env = std::getenv("BRAINVAULT_OPENCL_BATCH")) {
        char *end = nullptr;
        const unsigned long parsed = std::strtoul(batch_env, &end, 10);
        if (*batch_env == '\0' || *end != '\0' || parsed == 0 || parsed > 344) {
            throw std::runtime_error("invalid OpenCL batch");
        }
        requested_batch = static_cast<std::size_t>(parsed);
    }
    const std::size_t batch = std::min<std::size_t>(count, requested_batch);
    std::uint32_t jobs_per_block = 1;
    while (jobs_per_block < 8 && batch % (jobs_per_block * 2) == 0) {
        jobs_per_block *= 2;
    }
    if (const char *jobs_env = std::getenv("BRAINVAULT_OPENCL_JOBS_PER_BLOCK")) {
        char *end = nullptr;
        const unsigned long parsed = std::strtoul(jobs_env, &end, 10);
        if (*jobs_env == '\0' || *end != '\0' || parsed == 0
                || parsed > 8 || batch % parsed != 0) {
            throw std::runtime_error("invalid OpenCL jobs per block");
        }
        jobs_per_block = static_cast<std::uint32_t>(parsed);
    }
    const bool by_segment = std::getenv("BRAINVAULT_OPENCL_ONESHOT") == nullptr;
    const bool precompute = std::getenv("BRAINVAULT_OPENCL_NO_PRECOMPUTE") == nullptr;
    const bool profiling = std::getenv("BRAINVAULT_OPENCL_PROFILE") != nullptr;
    const bool progress_enabled = std::getenv("BRAINVAULT_NATIVE_PROGRESS") != nullptr;

    argon2::opencl::GlobalContext global;
    const auto &devices = global.getAllDevices();
    if (devices.empty()) throw std::runtime_error("no OpenCL GPU");
    const auto &device = devices[0];
    argon2::opencl::ProgramContext program(
        &global, { device }, argon2::ARGON2_ID, argon2::ARGON2_VERSION_13);
    const auto program_ready = probe_clock::now();
    argon2::Argon2Params common(32, nullptr, 0, nullptr, 0, nullptr, 0,
                               1, memory_kib, 1);
    argon2::opencl::ProcessingUnit unit(
        &program, &common, &device, batch, by_segment, precompute,
        jobs_per_block, profiling);
    const auto unit_ready = probe_clock::now();

    double initialize_ms = 0;
    double kernel_ms = 0;
    double finalize_ms = 0;

    for (std::size_t first = 0; first < count; first += batch) {
        const auto initialize_started = probe_clock::now();
        const std::size_t active = std::min<std::size_t>(batch, count - first);
        const std::uint8_t dummy_salt[32] = {};
        for (std::size_t index = 0; index < batch; ++index) {
            const void *salt = index < active
                ? salts.data() + ((first + index) * 32)
                : dummy_salt;
            argon2::Argon2Params job(32, salt, 32, nullptr, 0, nullptr, 0,
                                    1, memory_kib, 1);
            unit.setPasswordWithParams(index, job,
                                       password.data(), password.size());
        }
        const auto kernel_started = probe_clock::now();
        unit.beginProcessing();
        unit.endProcessing();
        const auto finalize_started = probe_clock::now();
        for (std::size_t index = 0; index < active; ++index) {
            unit.getHash(index, outputs.data() + ((first + index) * 32));
        }
        const auto chunk_finished = probe_clock::now();
        initialize_ms += std::chrono::duration<double, std::milli>(
            kernel_started - initialize_started).count();
        kernel_ms += std::chrono::duration<double, std::milli>(
            finalize_started - kernel_started).count();
        finalize_ms += std::chrono::duration<double, std::milli>(
            chunk_finished - finalize_started).count();
        if (progress_enabled) std::cerr << "BVP1 " << first + active << '\n';
    }

    const auto wipe_started = probe_clock::now();
    unit.clearMemory();
    const auto finished = probe_clock::now();
    if (profiling) {
        std::cerr << "profile program="
                  << std::chrono::duration<double, std::milli>(program_ready - started).count()
                  << "ms unit="
                  << std::chrono::duration<double, std::milli>(unit_ready - program_ready).count()
                  << "ms initialize=" << initialize_ms
                  << "ms kernel=" << kernel_ms
                  << "ms finalize=" << finalize_ms
                  << "ms wipe="
                  << std::chrono::duration<double, std::milli>(finished - wipe_started).count()
                  << "ms total="
                  << std::chrono::duration<double, std::milli>(finished - started).count()
                  << "ms\n";
    }

    if (std::fwrite(outputs.data(), 1, outputs.size(), stdout) != outputs.size()
            || std::fflush(stdout) != 0) {
        throw std::runtime_error("output failed");
    }
    return 0;
} catch (const cl::Error &error) {
    std::cerr << "OpenCL error: " << error.err() << ": " << error.what() << '\n';
    return 2;
} catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
}
