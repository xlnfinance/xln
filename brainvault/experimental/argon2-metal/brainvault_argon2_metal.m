#define __STDC_WANT_LIB_EXT1__ 1

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "argon2.h"
#include "core.h"
#include "blake2/blake2.h"

#define INPUT_MAGIC 0x32435642u
#define HEADER_BYTES 24u
#define SALT_BYTES 32u
#define OUTPUT_BYTES 32u
#define MAX_WORKERS 256u

typedef struct {
    uint32_t memory_blocks;
    uint32_t lane_length;
    uint32_t segment_length;
    uint32_t active_shards;
    uint32_t simdgroups_per_threadgroup;
    uint32_t slice;
} kernel_params;

static uint8_t *allocation_target;
static size_t allocation_capacity;

static double monotonic_ms(void) {
    struct timespec timestamp;
    if (clock_gettime(CLOCK_MONOTONIC, &timestamp) != 0) return 0.0;
    return ((double)timestamp.tv_sec * 1000.0) + ((double)timestamp.tv_nsec / 1000000.0);
}

static int supplied_allocate(uint8_t **memory, size_t bytes) {
    if (allocation_target == NULL || bytes > allocation_capacity) return -1;
    *memory = allocation_target;
    return 0;
}

static void supplied_free(uint8_t *memory, size_t bytes) {
    (void)memory;
    (void)bytes;
}

static uint32_t read_u32le(const uint8_t *bytes) {
    return ((uint32_t)bytes[0]) | ((uint32_t)bytes[1] << 8u) |
           ((uint32_t)bytes[2] << 16u) | ((uint32_t)bytes[3] << 24u);
}

static int read_exact(void *buffer, size_t length) {
    return fread(buffer, 1u, length, stdin) == length ? 0 : -1;
}

static NSString *metal_library_path(const char *executable) {
    char resolved[PATH_MAX];
    if (realpath(executable, resolved) == NULL) return nil;
    char *slash = strrchr(resolved, '/');
    if (slash == NULL) return nil;
    *slash = '\0';
    return [NSString stringWithFormat:@"%s/argon2.metallib", resolved];
}

static void configure_instance(
    argon2_instance_t *instance,
    argon2_context *context,
    uint8_t *output,
    uint8_t *password,
    uint32_t password_length,
    uint8_t *salt,
    uint32_t memory_kib,
    uint32_t memory_blocks,
    uint32_t segment_length
) {
    memset(context, 0, sizeof(*context));
    context->out = output;
    context->outlen = OUTPUT_BYTES;
    context->pwd = password;
    context->pwdlen = password_length;
    context->salt = salt;
    context->saltlen = SALT_BYTES;
    context->t_cost = 1u;
    context->m_cost = memory_kib;
    context->lanes = 1u;
    context->threads = 1u;
    context->version = ARGON2_VERSION_13;
    context->allocate_cbk = supplied_allocate;
    context->free_cbk = supplied_free;
    context->flags = ARGON2_DEFAULT_FLAGS;

    memset(instance, 0, sizeof(*instance));
    instance->version = ARGON2_VERSION_13;
    instance->passes = 1u;
    instance->memory_blocks = memory_blocks;
    instance->segment_length = segment_length;
    instance->lane_length = memory_blocks;
    instance->lanes = 1u;
    instance->threads = 1u;
    instance->type = Argon2_id;
}

static int run_metal(
    const char *executable,
    uint32_t shard_count,
    uint32_t workers,
    uint8_t *password,
    uint32_t password_length,
    uint8_t *salts,
    uint8_t *outputs,
    uint32_t memory_kib
) {
    double total_started = monotonic_ms();
    double initialize_ms = 0.0;
    double command_ms = 0.0;
    double finalize_ms = 0.0;
    double setup_ms = 0.0;
    double wipe_ms = 0.0;
    int result = -1;
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    if (device == nil) return -1;

    NSError *error = nil;
    NSString *library_path = metal_library_path(executable);
    if (library_path == nil) return -1;
    id<MTLLibrary> library = [device newLibraryWithURL:[NSURL fileURLWithPath:library_path] error:&error];
    if (library == nil) {
        fprintf(stderr, "metal library: %s\n", error.localizedDescription.UTF8String);
        return -1;
    }
    const char *requested_kernel = getenv("BRAINVAULT_METAL_KERNEL");
    NSString *kernel_name = @"argon2id_fill_shuffle";
    if (requested_kernel != NULL && strcmp(requested_kernel, "barrier") == 0) {
        kernel_name = @"argon2id_fill";
    } else if (requested_kernel != NULL && strcmp(requested_kernel, "modern64") == 0) {
        kernel_name = @"argon2id_fill_modern64_segment";
    } else if (requested_kernel != NULL && strcmp(requested_kernel, "segmented64") == 0) {
        kernel_name = @"argon2id_fill_shuffle64_segment";
    } else if (requested_kernel != NULL && strcmp(requested_kernel, "native64") == 0) {
        kernel_name = @"argon2id_fill_shuffle64";
    }
    id<MTLFunction> function = [library newFunctionWithName:kernel_name];
    if (function == nil) return -1;
    id<MTLComputePipelineState> pipeline = [device newComputePipelineStateWithFunction:function error:&error];
    if (pipeline == nil || pipeline.threadExecutionWidth != 32u) {
        fprintf(stderr, "metal pipeline: %s\n", error.localizedDescription.UTF8String);
        return -1;
    }
    id<MTLCommandQueue> queue = [device newCommandQueue];
    if (queue == nil) return -1;

    uint32_t segment_length = memory_kib / 4u;
    uint32_t memory_blocks = segment_length * 4u;
    if (segment_length < 2u) return -1;
    size_t bytes_per_shard = (size_t)memory_blocks * ARGON2_BLOCK_SIZE;
    if ((size_t)workers > SIZE_MAX / bytes_per_shard) return -1;
    size_t buffer_length = (size_t)workers * bytes_per_shard;
    if (buffer_length > device.maxBufferLength) {
        fprintf(stderr, "metal buffer exceeds device limit\n");
        return -1;
    }
    const char *private_value = getenv("BRAINVAULT_METAL_PRIVATE");
    BOOL private_memory = private_value != NULL && strcmp(private_value, "1") == 0;
    MTLResourceOptions memory_options = private_memory
        ? MTLResourceStorageModePrivate
        : MTLResourceStorageModeShared;
    id<MTLBuffer> memory = [device newBufferWithLength:buffer_length options:memory_options];
    if (memory == nil) return -1;
    size_t input_staging_length = (size_t)workers * 2u * ARGON2_BLOCK_SIZE;
    size_t output_staging_length = (size_t)workers * ARGON2_BLOCK_SIZE;
    size_t staging_length = input_staging_length + output_staging_length;
    id<MTLBuffer> staging = private_memory
        ? [device newBufferWithLength:staging_length options:MTLResourceStorageModeShared]
        : nil;
    if (private_memory && staging == nil) return -1;

    argon2_instance_t instances[MAX_WORKERS];
    argon2_context contexts[MAX_WORKERS];
    uint8_t *shared = private_memory
        ? (uint8_t *)staging.contents
        : (uint8_t *)memory.contents;
    setup_ms = monotonic_ms() - total_started;
    FLAG_clear_internal_memory = 1;

    for (uint32_t first = 0u; first < shard_count; first += workers) {
        uint32_t active = shard_count - first;
        if (active > workers) active = workers;
        double initialize_started = monotonic_ms();
        for (uint32_t slot = 0u; slot < active; ++slot) {
            /* initialize() writes only the first two blocks; private mode then
               blits those blocks into the full GPU arena before filling it. */
            allocation_target = private_memory
                ? shared + ((size_t)slot * 2u * ARGON2_BLOCK_SIZE)
                : shared + ((size_t)slot * bytes_per_shard);
            allocation_capacity = bytes_per_shard;
            configure_instance(
                &instances[slot],
                &contexts[slot],
                outputs + ((size_t)(first + slot) * OUTPUT_BYTES),
                password,
                password_length,
                salts + ((size_t)(first + slot) * SALT_BYTES),
                memory_kib,
                memory_blocks,
                segment_length
            );
            if (initialize(&instances[slot], &contexts[slot]) != ARGON2_OK) goto cleanup;
        }
        initialize_ms += monotonic_ms() - initialize_started;

        uint32_t simdgroups = 4u;
        const char *simdgroups_value = getenv("BRAINVAULT_METAL_SIMDGROUPS");
        if (simdgroups_value != NULL) {
            unsigned long parsed = strtoul(simdgroups_value, NULL, 10);
            if (parsed == 1u || parsed == 2u || parsed == 4u || parsed == 8u) simdgroups = (uint32_t)parsed;
        }
        if ([kernel_name isEqualToString:@"argon2id_fill"]) simdgroups = 1u;
        kernel_params params = {memory_blocks, memory_blocks, segment_length, active, simdgroups, 0u};
        double command_started = monotonic_ms();
        id<MTLCommandBuffer> command = [queue commandBuffer];
        if (command == nil) goto cleanup;
        if (private_memory) {
            id<MTLBlitCommandEncoder> upload = [command blitCommandEncoder];
            if (upload == nil) goto cleanup;
            for (uint32_t slot = 0u; slot < active; ++slot) {
                [upload copyFromBuffer:staging
                          sourceOffset:(size_t)slot * 2u * ARGON2_BLOCK_SIZE
                              toBuffer:memory
                     destinationOffset:(size_t)slot * bytes_per_shard
                                  size:2u * ARGON2_BLOCK_SIZE];
            }
            [upload endEncoding];
        }
        id<MTLComputeCommandEncoder> encoder = [command computeCommandEncoder];
        if (encoder == nil) goto cleanup;
        [encoder setComputePipelineState:pipeline];
        [encoder setBuffer:memory offset:0 atIndex:0];
        BOOL segmented = [kernel_name isEqualToString:@"argon2id_fill_shuffle64_segment"] ||
            [kernel_name isEqualToString:@"argon2id_fill_modern64_segment"];
        uint32_t dispatches = segmented ? 4u : 1u;
        for (uint32_t slice = 0u; slice < dispatches; ++slice) {
            params.slice = slice;
            [encoder setBytes:&params length:sizeof(params) atIndex:1];
            [encoder dispatchThreadgroups:MTLSizeMake((active + simdgroups - 1u) / simdgroups, 1u, 1u)
                      threadsPerThreadgroup:MTLSizeMake(32u * simdgroups, 1u, 1u)];
        }
        [encoder endEncoding];
        if (private_memory) {
            id<MTLBlitCommandEncoder> download = [command blitCommandEncoder];
            if (download == nil) goto cleanup;
            for (uint32_t slot = 0u; slot < active; ++slot) {
                [download copyFromBuffer:memory
                            sourceOffset:((size_t)slot * bytes_per_shard) + bytes_per_shard - ARGON2_BLOCK_SIZE
                                toBuffer:staging
                       destinationOffset:input_staging_length + ((size_t)slot * ARGON2_BLOCK_SIZE)
                                    size:ARGON2_BLOCK_SIZE];
            }
            [download endEncoding];
        }
        [command commit];
        [command waitUntilCompleted];
        if (command.status != MTLCommandBufferStatusCompleted) {
            fprintf(stderr, "metal command: %s\n", command.error.localizedDescription.UTF8String);
            goto cleanup;
        }
        command_ms += monotonic_ms() - command_started;

        double finalize_started = monotonic_ms();
        for (uint32_t slot = 0u; slot < active; ++slot) {
            uint8_t final_block[ARGON2_BLOCK_SIZE];
            const uint8_t *last = private_memory
                ? shared + input_staging_length + ((size_t)slot * ARGON2_BLOCK_SIZE)
                : (const uint8_t *)(instances[slot].memory + (memory_blocks - 1u));
            memcpy(final_block, last, sizeof(final_block));
            if (blake2b_long(
                    outputs + ((size_t)(first + slot) * OUTPUT_BYTES),
                    OUTPUT_BYTES,
                    final_block,
                    sizeof(final_block)) != 0) {
                (void)memset_s(final_block, sizeof(final_block), 0, sizeof(final_block));
                goto cleanup;
            }
            (void)memset_s(final_block, sizeof(final_block), 0, sizeof(final_block));
        }
        finalize_ms += monotonic_ms() - finalize_started;
    }
    result = 0;

cleanup:
    allocation_target = NULL;
    allocation_capacity = 0u;
    double wipe_started = monotonic_ms();
    if (private_memory && memory != nil) {
        id<MTLCommandBuffer> wipe_command = [queue commandBuffer];
        id<MTLBlitCommandEncoder> wipe = [wipe_command blitCommandEncoder];
        if (wipe_command == nil || wipe == nil) result = -1;
        else {
            [wipe fillBuffer:memory range:NSMakeRange(0u, buffer_length) value:0u];
            [wipe endEncoding];
            [wipe_command commit];
            [wipe_command waitUntilCompleted];
            if (wipe_command.status != MTLCommandBufferStatusCompleted) result = -1;
        }
        (void)memset_s(shared, staging_length, 0, staging_length);
    } else if (shared != NULL) {
        (void)memset_s(shared, buffer_length, 0, buffer_length);
    }
    wipe_ms = monotonic_ms() - wipe_started;
    if (getenv("BRAINVAULT_METAL_PROFILE") != NULL) {
        fprintf(stderr,
                "profile setup=%.3fms initialize=%.3fms command=%.3fms finalize=%.3fms wipe=%.3fms total=%.3fms\n",
                setup_ms, initialize_ms, command_ms, finalize_ms, wipe_ms,
                monotonic_ms() - total_started);
    }
    return result;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        uint8_t header[HEADER_BYTES];
        uint32_t shard_count = 0u, workers = 0u, password_length = 0u, flags = 0u, memory_kib = 0u;
        size_t salt_length = 0u, output_length = 0u;
        uint8_t *password = NULL, *salts = NULL, *outputs = NULL;
        int exit_code = 1;

        if (argc != 1 || read_exact(header, sizeof(header)) != 0) goto cleanup;
        if (read_u32le(header) != INPUT_MAGIC) goto cleanup;
        shard_count = read_u32le(header + 4u);
        workers = read_u32le(header + 8u);
        password_length = read_u32le(header + 12u);
        flags = read_u32le(header + 16u);
        memory_kib = read_u32le(header + 20u);
        if (shard_count == 0u || workers == 0u || workers > MAX_WORKERS || password_length == 0u ||
            password_length > (1u << 20u) || flags != 0u || memory_kib < 8u || memory_kib % 4u != 0u) {
            goto cleanup;
        }
        if ((size_t)shard_count > SIZE_MAX / SALT_BYTES || (size_t)shard_count > SIZE_MAX / OUTPUT_BYTES) goto cleanup;
        salt_length = (size_t)shard_count * SALT_BYTES;
        output_length = (size_t)shard_count * OUTPUT_BYTES;
        password = malloc(password_length);
        salts = malloc(salt_length);
        outputs = malloc(output_length);
        if (password == NULL || salts == NULL || outputs == NULL) goto cleanup;
        if (read_exact(password, password_length) != 0 || read_exact(salts, salt_length) != 0) goto cleanup;
        if (run_metal(argv[0], shard_count, workers, password, password_length, salts, outputs, memory_kib) != 0) goto cleanup;
        if (fwrite(outputs, 1u, output_length, stdout) != output_length) goto cleanup;
        exit_code = 0;

cleanup:
        if (password != NULL) (void)memset_s(password, password_length, 0, password_length);
        if (salts != NULL) (void)memset_s(salts, salt_length, 0, salt_length);
        if (outputs != NULL) (void)memset_s(outputs, output_length, 0, output_length);
        free(password);
        free(salts);
        free(outputs);
        return exit_code;
    }
}
