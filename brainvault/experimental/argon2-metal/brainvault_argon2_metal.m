#define __STDC_WANT_LIB_EXT1__ 1

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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
} kernel_params;

static uint8_t *allocation_target;
static size_t allocation_capacity;

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
    NSString *kernel_name = requested_kernel != NULL && strcmp(requested_kernel, "barrier") == 0
        ? @"argon2id_fill"
        : @"argon2id_fill_shuffle";
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
    id<MTLBuffer> memory = [device newBufferWithLength:buffer_length options:MTLResourceStorageModeShared];
    if (memory == nil) return -1;

    argon2_instance_t instances[MAX_WORKERS];
    argon2_context contexts[MAX_WORKERS];
    uint8_t *shared = (uint8_t *)memory.contents;
    FLAG_clear_internal_memory = 1;

    for (uint32_t first = 0u; first < shard_count; first += workers) {
        uint32_t active = shard_count - first;
        if (active > workers) active = workers;
        for (uint32_t slot = 0u; slot < active; ++slot) {
            allocation_target = shared + ((size_t)slot * bytes_per_shard);
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

        uint32_t simdgroups = 4u;
        const char *simdgroups_value = getenv("BRAINVAULT_METAL_SIMDGROUPS");
        if (simdgroups_value != NULL) {
            unsigned long parsed = strtoul(simdgroups_value, NULL, 10);
            if (parsed == 1u || parsed == 2u || parsed == 4u || parsed == 8u) simdgroups = (uint32_t)parsed;
        }
        if ([kernel_name isEqualToString:@"argon2id_fill"]) simdgroups = 1u;
        kernel_params params = {memory_blocks, memory_blocks, segment_length, active, simdgroups};
        id<MTLCommandBuffer> command = [queue commandBuffer];
        id<MTLComputeCommandEncoder> encoder = [command computeCommandEncoder];
        if (command == nil || encoder == nil) goto cleanup;
        [encoder setComputePipelineState:pipeline];
        [encoder setBuffer:memory offset:0 atIndex:0];
        [encoder setBytes:&params length:sizeof(params) atIndex:1];
        [encoder dispatchThreadgroups:MTLSizeMake((active + simdgroups - 1u) / simdgroups, 1u, 1u)
                  threadsPerThreadgroup:MTLSizeMake(32u * simdgroups, 1u, 1u)];
        [encoder endEncoding];
        [command commit];
        [command waitUntilCompleted];
        if (command.status != MTLCommandBufferStatusCompleted) {
            fprintf(stderr, "metal command: %s\n", command.error.localizedDescription.UTF8String);
            goto cleanup;
        }

        for (uint32_t slot = 0u; slot < active; ++slot) {
            uint8_t final_block[ARGON2_BLOCK_SIZE];
            block *last = instances[slot].memory + (memory_blocks - 1u);
            memcpy(final_block, last->v, sizeof(final_block));
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
    }
    result = 0;

cleanup:
    allocation_target = NULL;
    allocation_capacity = 0u;
    (void)memset_s(shared, buffer_length, 0, buffer_length);
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
        if (outputs != NULL) (void)memset_s(outputs, output_length, 0, output_length);
        free(password);
        free(salts);
        free(outputs);
        return exit_code;
    }
}
