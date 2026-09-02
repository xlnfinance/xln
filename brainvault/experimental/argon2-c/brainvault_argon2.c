#define __STDC_WANT_LIB_EXT1__ 1

#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "argon2.h"

#define INPUT_MAGIC 0x32435642u
#define HEADER_WORDS 6u
#define SALT_BYTES 32u
#define OUTPUT_BYTES 32u
#ifndef BRAINVAULT_MAX_WORKERS
#define BRAINVAULT_MAX_WORKERS 32u
#endif

typedef struct {
    uint32_t shard_count;
    const uint8_t *password;
    uint32_t password_len;
    const uint8_t *salts;
    uint8_t *outputs;
    uint32_t memory_kib;
    size_t memory_bytes;
    atomic_uint next_index;
    atomic_int error_code;
} shared_state;

static _Thread_local uint8_t *thread_memory;
static _Thread_local size_t thread_memory_bytes;

static int reuse_allocate(uint8_t **memory, size_t bytes_to_allocate) {
    if (thread_memory == NULL || bytes_to_allocate > thread_memory_bytes) return -1;
    *memory = thread_memory;
    return 0;
}

static void reuse_free(uint8_t *memory, size_t bytes_to_allocate) {
    (void)memory;
    (void)bytes_to_allocate;
}

static void secure_zero(void *pointer, size_t length) {
#if defined(__APPLE__)
    (void)memset_s(pointer, length, 0, length);
#else
    volatile uint8_t *bytes = (volatile uint8_t *)pointer;
    while (length-- != 0u) *bytes++ = 0;
#endif
}

static void *derive_worker(void *opaque) {
    shared_state *shared = (shared_state *)opaque;
    if (posix_memalign((void **)&thread_memory, 64u, shared->memory_bytes) != 0) {
        atomic_store(&shared->error_code, ARGON2_MEMORY_ALLOCATION_ERROR);
        return NULL;
    }
    thread_memory_bytes = shared->memory_bytes;

    for (;;) {
        uint32_t index = atomic_fetch_add(&shared->next_index, 1u);
        argon2_context context;
        int result;
        if (index >= shared->shard_count || atomic_load(&shared->error_code) != ARGON2_OK) break;

        memset(&context, 0, sizeof(context));
        context.out = shared->outputs + ((size_t)index * OUTPUT_BYTES);
        context.outlen = OUTPUT_BYTES;
        context.pwd = (uint8_t *)shared->password;
        context.pwdlen = shared->password_len;
        context.salt = (uint8_t *)shared->salts + ((size_t)index * SALT_BYTES);
        context.saltlen = SALT_BYTES;
        context.t_cost = 1u;
        context.m_cost = shared->memory_kib;
        context.lanes = 1u;
        context.threads = 1u;
        context.version = ARGON2_VERSION_13;
        context.allocate_cbk = reuse_allocate;
        context.free_cbk = reuse_free;
        context.flags = ARGON2_DEFAULT_FLAGS;

        result = argon2_ctx(&context, Argon2_id);
        if (result != ARGON2_OK) {
            atomic_store(&shared->error_code, result);
            break;
        }
    }

    secure_zero(thread_memory, thread_memory_bytes);
    free(thread_memory);
    thread_memory = NULL;
    thread_memory_bytes = 0u;
    return NULL;
}

static uint32_t read_u32le(const uint8_t *bytes) {
    return ((uint32_t)bytes[0]) | ((uint32_t)bytes[1] << 8u) |
           ((uint32_t)bytes[2] << 16u) | ((uint32_t)bytes[3] << 24u);
}

static int read_exact(void *buffer, size_t length) {
    return fread(buffer, 1u, length, stdin) == length ? 0 : -1;
}

int main(void) {
    uint8_t header[HEADER_WORDS * sizeof(uint32_t)];
    uint32_t shard_count, worker_count, password_len, flags, memory_kib;
    size_t salt_length, output_length, memory_bytes;
    uint8_t *password = NULL, *salts = NULL, *outputs = NULL;
    pthread_t threads[BRAINVAULT_MAX_WORKERS];
    shared_state shared;
    uint32_t started_threads = 0u;
    int exit_code = 1;

    if (read_exact(header, sizeof(header)) != 0) goto cleanup;
    if (read_u32le(header) != INPUT_MAGIC) goto cleanup;
    shard_count = read_u32le(header + 4u);
    worker_count = read_u32le(header + 8u);
    password_len = read_u32le(header + 12u);
    flags = read_u32le(header + 16u);
    memory_kib = read_u32le(header + 20u);
    if (shard_count == 0u || worker_count == 0u || worker_count > BRAINVAULT_MAX_WORKERS || password_len == 0u ||
        password_len > (1u << 20u) || memory_kib < 8u || (size_t)memory_kib > SIZE_MAX / 1024u) {
        goto cleanup;
    }
    memory_bytes = (size_t)memory_kib * 1024u;
    if ((size_t)shard_count > SIZE_MAX / SALT_BYTES || (size_t)shard_count > SIZE_MAX / OUTPUT_BYTES) goto cleanup;
    salt_length = (size_t)shard_count * SALT_BYTES;
    output_length = (size_t)shard_count * OUTPUT_BYTES;
    password = (uint8_t *)malloc(password_len);
    salts = (uint8_t *)malloc(salt_length);
    outputs = (uint8_t *)malloc(output_length);
    if (password == NULL || salts == NULL || outputs == NULL) goto cleanup;
    if (read_exact(password, password_len) != 0 || read_exact(salts, salt_length) != 0) goto cleanup;

    /* Reused memory is fully overwritten by every t=1 invocation. Wipe once at
       thread shutdown unless the comparison mode requests a wipe per shard. */
    FLAG_clear_internal_memory = (flags & 1u) != 0u;
    memset(&shared, 0, sizeof(shared));
    shared.shard_count = shard_count;
    shared.password = password;
    shared.password_len = password_len;
    shared.salts = salts;
    shared.outputs = outputs;
    shared.memory_kib = memory_kib;
    shared.memory_bytes = memory_bytes;
    atomic_init(&shared.next_index, 0u);
    atomic_init(&shared.error_code, ARGON2_OK);

    for (started_threads = 0u; started_threads < worker_count; ++started_threads) {
        if (pthread_create(&threads[started_threads], NULL, derive_worker, &shared) != 0) {
            atomic_store(&shared.error_code, ARGON2_THREAD_FAIL);
            break;
        }
    }
    for (uint32_t index = 0u; index < started_threads; ++index) pthread_join(threads[index], NULL);
    if (atomic_load(&shared.error_code) != ARGON2_OK) {
        fprintf(stderr, "argon2 error: %s\n", argon2_error_message(atomic_load(&shared.error_code)));
        goto cleanup;
    }
    if (fwrite(outputs, 1u, output_length, stdout) != output_length) goto cleanup;
    exit_code = 0;

cleanup:
    if (password != NULL) secure_zero(password, password_len);
    if (outputs != NULL && shard_count != 0u && (size_t)shard_count <= SIZE_MAX / OUTPUT_BYTES) {
        secure_zero(outputs, (size_t)shard_count * OUTPUT_BYTES);
    }
    free(password);
    free(salts);
    free(outputs);
    return exit_code;
}
