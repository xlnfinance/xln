#include <metal_stdlib>
using namespace metal;

constant uint WORDS_PER_BLOCK = 128;
constant uint SYNC_POINTS = 4;

struct KernelParams {
    uint memory_blocks;
    uint lane_length;
    uint segment_length;
    uint active_shards;
    uint simdgroups_per_threadgroup;
};

inline ulong rotate_right(ulong value, uint amount) {
    return (value >> amount) | (value << (64u - amount));
}

inline ulong blamka(ulong left, ulong right) {
    ulong product = ulong(uint(left)) * ulong(uint(right));
    return left + right + (product << 1u);
}

inline void blake_g(thread ulong &a, thread ulong &b, thread ulong &c, thread ulong &d) {
    a = blamka(a, b);
    d = rotate_right(d ^ a, 32u);
    c = blamka(c, d);
    b = rotate_right(b ^ c, 24u);
    a = blamka(a, b);
    d = rotate_right(d ^ a, 16u);
    c = blamka(c, d);
    b = rotate_right(b ^ c, 63u);
}

inline uint round_index(uint lane, uint position, bool columns) {
    return columns
        ? (2u * lane) + ((position >> 1u) * 16u) + (position & 1u)
        : (16u * lane) + position;
}

inline void blake_round(threadgroup ulong *state, uint lane, bool columns) {
    const uint i0 = round_index(lane, 0u, columns);
    const uint i1 = round_index(lane, 1u, columns);
    const uint i2 = round_index(lane, 2u, columns);
    const uint i3 = round_index(lane, 3u, columns);
    const uint i4 = round_index(lane, 4u, columns);
    const uint i5 = round_index(lane, 5u, columns);
    const uint i6 = round_index(lane, 6u, columns);
    const uint i7 = round_index(lane, 7u, columns);
    const uint i8 = round_index(lane, 8u, columns);
    const uint i9 = round_index(lane, 9u, columns);
    const uint i10 = round_index(lane, 10u, columns);
    const uint i11 = round_index(lane, 11u, columns);
    const uint i12 = round_index(lane, 12u, columns);
    const uint i13 = round_index(lane, 13u, columns);
    const uint i14 = round_index(lane, 14u, columns);
    const uint i15 = round_index(lane, 15u, columns);

    ulong v0 = state[i0], v1 = state[i1], v2 = state[i2], v3 = state[i3];
    ulong v4 = state[i4], v5 = state[i5], v6 = state[i6], v7 = state[i7];
    ulong v8 = state[i8], v9 = state[i9], v10 = state[i10], v11 = state[i11];
    ulong v12 = state[i12], v13 = state[i13], v14 = state[i14], v15 = state[i15];

    blake_g(v0, v4, v8, v12);
    blake_g(v1, v5, v9, v13);
    blake_g(v2, v6, v10, v14);
    blake_g(v3, v7, v11, v15);
    blake_g(v0, v5, v10, v15);
    blake_g(v1, v6, v11, v12);
    blake_g(v2, v7, v8, v13);
    blake_g(v3, v4, v9, v14);

    state[i0] = v0; state[i1] = v1; state[i2] = v2; state[i3] = v3;
    state[i4] = v4; state[i5] = v5; state[i6] = v6; state[i7] = v7;
    state[i8] = v8; state[i9] = v9; state[i10] = v10; state[i11] = v11;
    state[i12] = v12; state[i13] = v13; state[i14] = v14; state[i15] = v15;
}

inline void permute(threadgroup ulong *state, uint thread_index) {
    if (thread_index < 8u) blake_round(state, thread_index, false);
    simdgroup_barrier(mem_flags::mem_threadgroup);
    if (thread_index < 8u) blake_round(state, thread_index, true);
    simdgroup_barrier(mem_flags::mem_threadgroup);
}

inline void fill_device_block(
    device ulong *previous,
    device ulong *reference,
    device ulong *next,
    threadgroup ulong *state,
    threadgroup ulong *copy,
    uint thread_index
) {
    for (uint word = thread_index; word < WORDS_PER_BLOCK; word += 32u) {
        ulong mixed = previous[word] ^ reference[word];
        state[word] = mixed;
        copy[word] = mixed;
    }
    simdgroup_barrier(mem_flags::mem_threadgroup);
    permute(state, thread_index);
    for (uint word = thread_index; word < WORDS_PER_BLOCK; word += 32u) {
        next[word] = state[word] ^ copy[word];
    }
    simdgroup_barrier(mem_flags::mem_device | mem_flags::mem_threadgroup);
}

inline void fill_threadgroup_block(
    threadgroup ulong *previous,
    threadgroup ulong *reference,
    threadgroup ulong *next,
    threadgroup ulong *state,
    threadgroup ulong *copy,
    uint thread_index
) {
    for (uint word = thread_index; word < WORDS_PER_BLOCK; word += 32u) {
        ulong mixed = previous[word] ^ reference[word];
        state[word] = mixed;
        copy[word] = mixed;
    }
    simdgroup_barrier(mem_flags::mem_threadgroup);
    permute(state, thread_index);
    for (uint word = thread_index; word < WORDS_PER_BLOCK; word += 32u) {
        next[word] = state[word] ^ copy[word];
    }
    simdgroup_barrier(mem_flags::mem_threadgroup);
}

inline void next_addresses(
    threadgroup ulong *address,
    threadgroup ulong *input,
    threadgroup ulong *zero,
    threadgroup ulong *state,
    threadgroup ulong *copy,
    uint thread_index
) {
    if (thread_index == 0u) input[6] += 1u;
    simdgroup_barrier(mem_flags::mem_threadgroup);
    fill_threadgroup_block(zero, input, address, state, copy, thread_index);
    fill_threadgroup_block(zero, address, address, state, copy, thread_index);
}

inline uint reference_index(uint slice, uint index, uint pseudo_random, uint segment_length, uint lane_length) {
    uint reference_area = slice == 0u
        ? index - 1u
        : (slice * segment_length) + index - 1u;
    uint relative = mulhi(pseudo_random, pseudo_random);
    relative = reference_area - 1u - mulhi(reference_area, relative);
    return relative % lane_length;
}

kernel void argon2id_fill(
    device ulong *memory [[buffer(0)]],
    constant KernelParams &params [[buffer(1)]],
    uint shard [[threadgroup_position_in_grid]],
    uint thread_index [[thread_index_in_threadgroup]],
    uint simd_width [[threads_per_simdgroup]]
) {
    if (shard >= params.active_shards || simd_width != 32u) return;
    device ulong *arena = memory + (ulong(shard) * ulong(params.memory_blocks) * WORDS_PER_BLOCK);
    threadgroup ulong state[WORDS_PER_BLOCK];
    threadgroup ulong copy[WORDS_PER_BLOCK];
    threadgroup ulong address[WORDS_PER_BLOCK];
    threadgroup ulong input[WORDS_PER_BLOCK];
    threadgroup ulong zero[WORDS_PER_BLOCK];

    for (uint slice = 0u; slice < SYNC_POINTS; ++slice) {
        const bool independent = slice < 2u;
        if (independent) {
            for (uint word = thread_index; word < WORDS_PER_BLOCK; word += 32u) {
                input[word] = 0u;
                address[word] = 0u;
                zero[word] = 0u;
            }
            simdgroup_barrier(mem_flags::mem_threadgroup);
            if (thread_index == 0u) {
                input[0] = 0u;
                input[1] = 0u;
                input[2] = slice;
                input[3] = params.memory_blocks;
                input[4] = 1u;
                input[5] = 2u;
            }
            simdgroup_barrier(mem_flags::mem_threadgroup);
        }

        uint start = slice == 0u ? 2u : 0u;
        if (slice == 0u) {
            next_addresses(address, input, zero, state, copy, thread_index);
        }
        uint current = (slice * params.segment_length) + start;
        uint previous = current == 0u ? params.lane_length - 1u : current - 1u;

        for (uint index = start; index < params.segment_length; ++index, ++current, ++previous) {
            if (current % params.lane_length == 1u) previous = current - 1u;
            ulong pseudo_random;
            if (independent) {
                if (index % WORDS_PER_BLOCK == 0u) {
                    next_addresses(address, input, zero, state, copy, thread_index);
                }
                pseudo_random = address[index % WORDS_PER_BLOCK];
            } else {
                pseudo_random = arena[ulong(previous) * WORDS_PER_BLOCK];
            }
            uint reference = reference_index(
                slice,
                index,
                uint(pseudo_random),
                params.segment_length,
                params.lane_length
            );
            fill_device_block(
                arena + (ulong(previous) * WORDS_PER_BLOCK),
                arena + (ulong(reference) * WORDS_PER_BLOCK),
                arena + (ulong(current) * WORDS_PER_BLOCK),
                state,
                copy,
                thread_index
            );
        }
    }
}

struct RegisterBlock {
    uint2 a;
    uint2 b;
    uint2 c;
    uint2 d;
};

inline uint2 shuffle_u64(uint2 value, uint source) {
    return simd_shuffle(value, ushort(source));
}

inline uint2 register_get(thread RegisterBlock &block, uint index) {
    switch (index) {
        case 0u: return block.a;
        case 1u: return block.b;
        case 2u: return block.c;
        default: return block.d;
    }
}

inline void register_set(thread RegisterBlock &block, uint index, uint2 value) {
    switch (index) {
        case 0u: block.a = value; break;
        case 1u: block.b = value; break;
        case 2u: block.c = value; break;
        default: block.d = value; break;
    }
}

inline void register_xor(thread RegisterBlock &left, thread RegisterBlock &right) {
    left.a ^= right.a;
    left.b ^= right.b;
    left.c ^= right.c;
    left.d ^= right.d;
}

inline void register_load(thread RegisterBlock &block, device uint2 *source, uint thread_index) {
    block.a = source[thread_index];
    block.b = source[32u + thread_index];
    block.c = source[64u + thread_index];
    block.d = source[96u + thread_index];
}

inline void register_load_xor(thread RegisterBlock &block, device uint2 *source, uint thread_index) {
    block.a ^= source[thread_index];
    block.b ^= source[32u + thread_index];
    block.c ^= source[64u + thread_index];
    block.d ^= source[96u + thread_index];
}

inline void register_store(device uint2 *destination, thread RegisterBlock &block, uint thread_index) {
    destination[thread_index] = block.a;
    destination[32u + thread_index] = block.b;
    destination[64u + thread_index] = block.c;
    destination[96u + thread_index] = block.d;
}

inline uint2 add_u64(uint2 left, uint2 right) {
    uint low = left.x + right.x;
    return uint2(low, left.y + right.y + uint(low < left.x));
}

inline uint2 xor_u64(uint2 left, uint2 right) {
    return left ^ right;
}

inline uint2 rotate_u64(uint2 value, uint amount) {
    switch (amount) {
        case 32u: return uint2(value.y, value.x);
        case 24u: return uint2((value.x >> 24u) | (value.y << 8u), (value.y >> 24u) | (value.x << 8u));
        case 16u: return uint2((value.x >> 16u) | (value.y << 16u), (value.y >> 16u) | (value.x << 16u));
        default: return uint2((value.x << 1u) | (value.y >> 31u), (value.y << 1u) | (value.x >> 31u));
    }
}

inline uint2 blamka_u64(uint2 left, uint2 right) {
    uint2 product = uint2(left.x * right.x, mulhi(left.x, right.x));
    return add_u64(add_u64(left, right), add_u64(product, product));
}

inline void register_g(thread RegisterBlock &block) {
    block.a = blamka_u64(block.a, block.b);
    block.d = rotate_u64(xor_u64(block.d, block.a), 32u);
    block.c = blamka_u64(block.c, block.d);
    block.b = rotate_u64(xor_u64(block.b, block.c), 24u);
    block.a = blamka_u64(block.a, block.b);
    block.d = rotate_u64(xor_u64(block.d, block.a), 16u);
    block.c = blamka_u64(block.c, block.d);
    block.b = rotate_u64(xor_u64(block.b, block.c), 63u);
}

inline uint shuffle_shift1_source(uint thread_index, uint word) {
    return (thread_index & 0x1cu) | ((thread_index + word) & 0x3u);
}

inline uint shuffle_unshift1_source(uint thread_index, uint word) {
    return shuffle_shift1_source(thread_index, (4u - word) & 0x3u);
}

inline uint shuffle_shift2_source(uint thread_index, uint word) {
    uint low = (thread_index & 0x1u) | ((thread_index & 0x10u) >> 3u);
    low = (low + word) & 0x3u;
    return ((low & 0x2u) << 3u) | (thread_index & 0xeu) | (low & 0x1u);
}

inline uint shuffle_unshift2_source(uint thread_index, uint word) {
    return shuffle_shift2_source(thread_index, (4u - word) & 0x3u);
}

inline void register_shift1(thread RegisterBlock &block, uint thread_index, bool inverse) {
    #pragma unroll
    for (uint word = 0u; word < 4u; ++word) {
        uint source = inverse
            ? shuffle_unshift1_source(thread_index, word)
            : shuffle_shift1_source(thread_index, word);
        register_set(block, word, shuffle_u64(register_get(block, word), source));
    }
}

inline void register_shift2(thread RegisterBlock &block, uint thread_index, bool inverse) {
    #pragma unroll
    for (uint word = 0u; word < 4u; ++word) {
        uint source = inverse
            ? shuffle_unshift2_source(thread_index, word)
            : shuffle_shift2_source(thread_index, word);
        register_set(block, word, shuffle_u64(register_get(block, word), source));
    }
}

inline void register_transpose(thread RegisterBlock &block, uint thread_index) {
    uint group = (thread_index & 0x0cu) >> 2u;
    #pragma unroll
    for (uint word = 1u; word < 4u; ++word) {
        uint source = (word << 2u) ^ thread_index;
        uint index = group ^ word;
        register_set(block, index, shuffle_u64(register_get(block, index), source));
    }
}

inline void register_permute(thread RegisterBlock &block, uint thread_index) {
    register_transpose(block, thread_index);
    register_g(block);
    register_shift1(block, thread_index, false);
    register_g(block);
    register_shift1(block, thread_index, true);
    register_transpose(block, thread_index);
    register_g(block);
    register_shift2(block, thread_index, false);
    register_g(block);
    register_shift2(block, thread_index, true);
}

inline void register_next_addresses(
    thread RegisterBlock &address,
    thread RegisterBlock &temporary,
    uint input_word,
    uint thread_index
) {
    address.a = uint2(input_word, 0u);
    address.b = uint2(0u);
    address.c = uint2(0u);
    address.d = uint2(0u);
    register_permute(address, thread_index);
    address.a ^= uint2(input_word, 0u);
    temporary = address;
    register_permute(address, thread_index);
    register_xor(address, temporary);
}

inline void register_fill(
    device uint2 *arena,
    device uint2 *current,
    thread RegisterBlock &previous,
    thread RegisterBlock &temporary,
    uint reference,
    uint thread_index
) {
    register_load_xor(previous, arena + (ulong(reference) * WORDS_PER_BLOCK), thread_index);
    temporary = previous;
    register_permute(previous, thread_index);
    register_xor(previous, temporary);
    register_store(current, previous, thread_index);
}

kernel void argon2id_fill_shuffle(
    device uint2 *memory [[buffer(0)]],
    constant KernelParams &params [[buffer(1)]],
    uint threadgroup_index [[threadgroup_position_in_grid]],
    uint simdgroup_index [[simdgroup_index_in_threadgroup]],
    uint thread_index [[thread_index_in_simdgroup]],
    uint simd_width [[threads_per_simdgroup]]
) {
    uint shard = (threadgroup_index * params.simdgroups_per_threadgroup) + simdgroup_index;
    if (shard >= params.active_shards || simd_width != 32u) return;
    device uint2 *arena = memory + (size_t(shard) * size_t(params.memory_blocks) * WORDS_PER_BLOCK);
    RegisterBlock previous, temporary, address;
    uint input_word;
    switch (thread_index) {
        case 3u: input_word = params.memory_blocks; break;
        case 4u: input_word = 1u; break;
        case 5u: input_word = 2u; break;
        default: input_word = 0u; break;
    }
    if (params.segment_length > 2u) {
        if (thread_index == 6u) input_word += 1u;
        register_next_addresses(address, temporary, input_word, thread_index);
    }

    register_load(previous, arena + WORDS_PER_BLOCK, thread_index);
    device uint2 *current = arena + (2u * WORDS_PER_BLOCK);
    uint skip = 2u;
    for (uint slice = 0u; slice < SYNC_POINTS; ++slice) {
        for (uint offset = 0u; offset < params.segment_length; ++offset) {
            if (skip != 0u) {
                --skip;
                continue;
            }
            uint reference;
            if (slice < 2u) {
                uint address_index = offset % WORDS_PER_BLOCK;
                if (address_index == 0u) {
                    if (thread_index == 6u) input_word += 1u;
                    register_next_addresses(address, temporary, input_word, thread_index);
                }
                uint source_thread = address_index % 32u;
                uint source_word = address_index / 32u;
                uint2 random = shuffle_u64(register_get(address, source_word), source_thread);
                reference = reference_index(
                    slice,
                    offset,
                    random.x,
                    params.segment_length,
                    params.lane_length
                );
            } else {
                uint2 random = shuffle_u64(previous.a, 0u);
                reference = reference_index(
                    slice,
                    offset,
                    random.x,
                    params.segment_length,
                    params.lane_length
                );
            }
            register_fill(arena, current, previous, temporary, reference, thread_index);
            current += WORDS_PER_BLOCK;
        }
        simdgroup_barrier(mem_flags::mem_device);
        if (thread_index == 2u) input_word += 1u;
        if (thread_index == 6u) input_word = 0u;
    }
}
