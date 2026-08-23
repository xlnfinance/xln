const std = @import("std");

const Keccak256 = std.crypto.hash.sha3.Keccak256;
const Secp256k1 = std.crypto.sign.ecdsa.EcdsaSecp256k1Sha256;

// Canonical fixed-width benchmark input. Every worker receives only these bytes
// plus the shared public key; no host objects cross the kernel boundary.
const INPUT_BYTES = 128;
const ACCOUNT_OFFSET = 0;
const SEQUENCE_OFFSET = 4;
const DELTA_OFFSET = 12;
const DIGEST_OFFSET = 20;
const SIGNATURE_OFFSET = 52;
const SIGNATURE_BYTES = 64;

// Ordered output wire form: kind + account + sequence + balance + leaf.
const EVENT_BYTES = 53;
const TRANSITION_PREIMAGE_BYTES = 68;
const LEAF_PREIMAGE_BYTES = 92;

const AccountState = struct {
    nonce: u64 = 0,
    balance: i64 = 0,
    leaf: [32]u8 = [_]u8{0} ** 32,
};

const Event = struct {
    kind: u8,
    account: u32,
    sequence: u64,
    balance: i64,
    leaf: [32]u8,
};

const Config = struct {
    items: usize = 25_000,
    accounts: usize = 4_096,
    threads: usize,
};

const Measurement = struct {
    elapsed_ns: u64,
    checksum: [32]u8,
    copied_bytes: usize,
};

const WorkerContext = struct {
    inputs: []const u8,
    states: []AccountState,
    events: []Event,
    public_key: Secp256k1.PublicKey,
    first_record: usize,
    last_record: usize,
    verify_signatures: bool,
    failed: bool = false,
};

fn usage() void {
    std.debug.print(
        \\native-account-zig [--items N] [--accounts N] [--threads N]
        \\
        \\Runs one-thread/all-core Account byte kernels with secp256k1 verify
        \\enabled and disabled, both excluding and including input-copy/event-
        \\serialization cost. Inputs are grouped by Account so workers never
        \\share mutable state; event slots retain exact input order.
        \\
    , .{});
}

fn parseConfig(init: std.process.Init) !Config {
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    var config = Config{ .threads = @max(1, std.Thread.getCpuCount() catch 1) };
    var index: usize = 1;
    while (index < args.len) : (index += 1) {
        const arg = args[index];
        if (std.mem.eql(u8, arg, "--help")) {
            usage();
            std.process.exit(0);
        }
        const value = if (index + 1 < args.len) args[index + 1] else return error.MissingArgumentValue;
        if (std.mem.eql(u8, arg, "--items")) {
            config.items = try std.fmt.parseUnsigned(usize, value, 10);
        } else if (std.mem.eql(u8, arg, "--accounts")) {
            config.accounts = try std.fmt.parseUnsigned(usize, value, 10);
        } else if (std.mem.eql(u8, arg, "--threads")) {
            config.threads = try std.fmt.parseUnsigned(usize, value, 10);
        } else {
            return error.UnknownArgument;
        }
        index += 1;
    }
    if (config.items == 0 or config.accounts == 0 or config.threads == 0) return error.ZeroConfiguration;
    config.accounts = @min(config.accounts, config.items);
    config.threads = @min(config.threads, config.accounts);
    return config;
}

fn writeU32(out: []u8, offset: usize, value: u32) void {
    std.mem.writeInt(u32, out[offset..][0..4], value, .little);
}

fn writeU64(out: []u8, offset: usize, value: u64) void {
    std.mem.writeInt(u64, out[offset..][0..8], value, .little);
}

fn writeI64(out: []u8, offset: usize, value: i64) void {
    std.mem.writeInt(i64, out[offset..][0..8], value, .little);
}

fn readU32(input: []const u8, offset: usize) u32 {
    return std.mem.readInt(u32, input[offset..][0..4], .little);
}

fn readU64(input: []const u8, offset: usize) u64 {
    return std.mem.readInt(u64, input[offset..][0..8], .little);
}

fn readI64(input: []const u8, offset: usize) i64 {
    return std.mem.readInt(i64, input[offset..][0..8], .little);
}

fn accountRecordStart(account: usize, items: usize, accounts: usize) usize {
    const base = items / accounts;
    const remainder = items % accounts;
    return account * base + @min(account, remainder);
}

fn transitionDigest(
    account: u32,
    sequence: u64,
    balance: i64,
    delta: i64,
    previous_leaf: [32]u8,
) [32]u8 {
    var preimage: [TRANSITION_PREIMAGE_BYTES]u8 = undefined;
    @memcpy(preimage[0..8], "xln:ain1");
    writeU32(&preimage, 8, account);
    writeU64(&preimage, 12, sequence);
    writeI64(&preimage, 20, balance);
    writeI64(&preimage, 28, delta);
    @memcpy(preimage[36..68], &previous_leaf);
    var digest: [32]u8 = undefined;
    Keccak256.hash(&preimage, &digest, .{});
    return digest;
}

fn leafDigest(
    account: u32,
    sequence: u64,
    balance: i64,
    previous_leaf: [32]u8,
    input_digest: [32]u8,
) [32]u8 {
    var preimage: [LEAF_PREIMAGE_BYTES]u8 = undefined;
    @memcpy(preimage[0..8], "xln:leaf");
    writeU32(&preimage, 8, account);
    writeU64(&preimage, 12, sequence);
    writeI64(&preimage, 20, balance);
    @memcpy(preimage[28..60], &previous_leaf);
    @memcpy(preimage[60..92], &input_digest);
    var digest: [32]u8 = undefined;
    Keccak256.hash(&preimage, &digest, .{});
    return digest;
}

fn populateInputs(inputs: []u8, items: usize, accounts: usize, key_pair: Secp256k1.KeyPair) !void {
    @memset(inputs, 0);
    for (0..accounts) |account| {
        var state = AccountState{};
        const start = accountRecordStart(account, items, accounts);
        const end = accountRecordStart(account + 1, items, accounts);
        for (start..end) |record_index| {
            const raw = inputs[record_index * INPUT_BYTES ..][0..INPUT_BYTES];
            const sequence = record_index - start + 1;
            const magnitude: i64 = @intCast((record_index % 100) + 1);
            const delta = if ((record_index & 1) == 0) magnitude else -magnitude;
            writeU32(raw, ACCOUNT_OFFSET, @intCast(account));
            writeU64(raw, SEQUENCE_OFFSET, @intCast(sequence));
            writeI64(raw, DELTA_OFFSET, delta);

            const digest = transitionDigest(
                @intCast(account),
                @intCast(sequence),
                state.balance,
                delta,
                state.leaf,
            );
            @memcpy(raw[DIGEST_OFFSET .. DIGEST_OFFSET + digest.len], &digest);
            const signature = try key_pair.signPrehashed(digest, null);
            const signature_bytes = signature.toBytes();
            @memcpy(raw[SIGNATURE_OFFSET .. SIGNATURE_OFFSET + SIGNATURE_BYTES], &signature_bytes);

            const next_balance = try std.math.add(i64, state.balance, delta);
            state.nonce = @intCast(sequence);
            state.balance = next_balance;
            state.leaf = leafDigest(
                @intCast(account),
                @intCast(sequence),
                next_balance,
                state.leaf,
                digest,
            );
        }
    }
}

fn applyRecord(
    raw: []const u8,
    state: *AccountState,
    public_key: Secp256k1.PublicKey,
    verify_signature: bool,
) !Event {
    const account = readU32(raw, ACCOUNT_OFFSET);
    const sequence = readU64(raw, SEQUENCE_OFFSET);
    const delta = readI64(raw, DELTA_OFFSET);
    const digest = raw[DIGEST_OFFSET .. DIGEST_OFFSET + 32].*;
    const expected_digest = transitionDigest(account, sequence, state.balance, delta, state.leaf);
    if (!std.mem.eql(u8, &digest, &expected_digest)) return error.AccountDigestMismatch;
    if (verify_signature) {
        const signature_bytes = raw[SIGNATURE_OFFSET .. SIGNATURE_OFFSET + SIGNATURE_BYTES].*;
        const signature = Secp256k1.Signature.fromBytes(signature_bytes);
        try signature.verifyPrehashed(digest, public_key);
    }
    if (sequence != state.nonce + 1) return error.AccountNonceMismatch;
    const next_balance = try std.math.add(i64, state.balance, delta);

    const next_leaf = leafDigest(account, sequence, next_balance, state.leaf, digest);

    state.nonce = sequence;
    state.balance = next_balance;
    state.leaf = next_leaf;
    return .{
        .kind = 1,
        .account = account,
        .sequence = sequence,
        .balance = next_balance,
        .leaf = next_leaf,
    };
}

fn workerMain(context: *WorkerContext) void {
    for (context.first_record..context.last_record) |record_index| {
        const raw = context.inputs[record_index * INPUT_BYTES ..][0..INPUT_BYTES];
        const account = readU32(raw, ACCOUNT_OFFSET);
        if (account >= context.states.len) {
            context.failed = true;
            return;
        }
        context.events[record_index] = applyRecord(
            raw,
            &context.states[account],
            context.public_key,
            context.verify_signatures,
        ) catch {
            context.failed = true;
            return;
        };
    }
}

fn runKernel(
    allocator: std.mem.Allocator,
    inputs: []const u8,
    states: []AccountState,
    events: []Event,
    public_key: Secp256k1.PublicKey,
    items: usize,
    accounts: usize,
    thread_count: usize,
    verify_signatures: bool,
) !void {
    if (thread_count == 1) {
        var context = WorkerContext{
            .inputs = inputs,
            .states = states,
            .events = events,
            .public_key = public_key,
            .first_record = 0,
            .last_record = items,
            .verify_signatures = verify_signatures,
        };
        workerMain(&context);
        if (context.failed) return error.AccountKernelFailed;
        return;
    }

    const contexts = try allocator.alloc(WorkerContext, thread_count);
    defer allocator.free(contexts);
    const threads = try allocator.alloc(std.Thread, thread_count);
    defer allocator.free(threads);
    var spawned: usize = 0;
    errdefer for (threads[0..spawned]) |thread| thread.join();

    for (0..thread_count) |slot| {
        const first_account = slot * accounts / thread_count;
        const last_account = (slot + 1) * accounts / thread_count;
        contexts[slot] = .{
            .inputs = inputs,
            .states = states,
            .events = events,
            .public_key = public_key,
            .first_record = accountRecordStart(first_account, items, accounts),
            .last_record = accountRecordStart(last_account, items, accounts),
            .verify_signatures = verify_signatures,
        };
        threads[slot] = try std.Thread.spawn(.{}, workerMain, .{&contexts[slot]});
        spawned += 1;
    }
    for (threads) |thread| thread.join();
    for (contexts) |context| if (context.failed) return error.AccountKernelFailed;
}

fn serializeEvents(events: []const Event, output: []u8) void {
    for (events, 0..) |event, index| {
        const raw = output[index * EVENT_BYTES ..][0..EVENT_BYTES];
        raw[0] = event.kind;
        writeU32(raw, 1, event.account);
        writeU64(raw, 5, event.sequence);
        writeI64(raw, 13, event.balance);
        @memcpy(raw[21..53], &event.leaf);
    }
}

fn checksumEvents(events: []const Event) [32]u8 {
    var hasher = Keccak256.init(.{});
    var raw: [EVENT_BYTES]u8 = undefined;
    for (events) |event| {
        raw[0] = event.kind;
        writeU32(&raw, 1, event.account);
        writeU64(&raw, 5, event.sequence);
        writeI64(&raw, 13, event.balance);
        @memcpy(raw[21..53], &event.leaf);
        hasher.update(&raw);
    }
    var digest: [32]u8 = undefined;
    hasher.final(&digest);
    return digest;
}

fn measure(
    init: std.process.Init,
    canonical_inputs: []const u8,
    public_key: Secp256k1.PublicKey,
    config: Config,
    thread_count: usize,
    verify_signatures: bool,
    include_copy_and_serialization: bool,
) !Measurement {
    const allocator = init.gpa;
    const states = try allocator.alloc(AccountState, config.accounts);
    defer allocator.free(states);
    @memset(states, AccountState{});
    const events = try allocator.alloc(Event, config.items);
    defer allocator.free(events);

    const scratch_inputs: []u8 = if (include_copy_and_serialization)
        try allocator.alloc(u8, canonical_inputs.len)
    else
        @constCast(&[_]u8{});
    defer if (include_copy_and_serialization) allocator.free(scratch_inputs);
    const serialized_events: []u8 = if (include_copy_and_serialization)
        try allocator.alloc(u8, config.items * EVENT_BYTES)
    else
        @constCast(&[_]u8{});
    defer if (include_copy_and_serialization) allocator.free(serialized_events);

    const start = std.Io.Clock.Timestamp.now(init.io, .awake);
    const inputs = if (include_copy_and_serialization) copy: {
        @memcpy(scratch_inputs, canonical_inputs);
        break :copy scratch_inputs;
    } else canonical_inputs;
    try runKernel(
        allocator,
        inputs,
        states,
        events,
        public_key,
        config.items,
        config.accounts,
        thread_count,
        verify_signatures,
    );
    if (include_copy_and_serialization) serializeEvents(events, serialized_events);
    const elapsed = start.untilNow(init.io);
    std.mem.doNotOptimizeAway(events.ptr);
    if (include_copy_and_serialization) std.mem.doNotOptimizeAway(serialized_events.ptr);

    return .{
        .elapsed_ns = @intCast(elapsed.raw.toNanoseconds()),
        .checksum = checksumEvents(events),
        .copied_bytes = if (include_copy_and_serialization)
            canonical_inputs.len + serialized_events.len
        else
            0,
    };
}

fn printMeasurement(
    label: []const u8,
    measurement: Measurement,
    items: usize,
    expected_checksum: *?[32]u8,
) !void {
    if (expected_checksum.*) |expected| {
        if (!std.mem.eql(u8, &expected, &measurement.checksum)) return error.NondeterministicOrderedOutput;
    } else {
        expected_checksum.* = measurement.checksum;
    }
    const elapsed_ms = @as(f64, @floatFromInt(measurement.elapsed_ns)) / 1_000_000.0;
    const ops_per_second = @as(f64, @floatFromInt(items)) * 1_000_000_000.0 /
        @as(f64, @floatFromInt(measurement.elapsed_ns));
    std.debug.print(
        "{s} elapsed_ms={d:.3} ops_s={d:.0} copied_bytes={} checksum={x}\n",
        .{ label, elapsed_ms, ops_per_second, measurement.copied_bytes, measurement.checksum[0..8] },
    );
}

pub fn main(init: std.process.Init) !void {
    const config = try parseConfig(init);
    const allocator = init.gpa;
    const inputs = try allocator.alloc(u8, config.items * INPUT_BYTES);
    defer allocator.free(inputs);

    const seed = [_]u8{0x42} ** Secp256k1.KeyPair.seed_length;
    const key_pair = try Secp256k1.KeyPair.generateDeterministic(seed);
    try populateInputs(inputs, config.items, config.accounts, key_pair);

    std.debug.print(
        "zig_native_account items={} accounts={} all_core_threads={} input_bytes={} event_bytes={}\n" ++
            "crypto_verify=std.crypto.secp256k1 recover=unavailable(no system libsecp256k1)\n",
        .{ config.items, config.accounts, config.threads, INPUT_BYTES, EVENT_BYTES },
    );

    for ([_]bool{ true, false }) |verify_signatures| {
        var expected_checksum: ?[32]u8 = null;
        const crypto_label: []const u8 = if (verify_signatures) "verify" else "no_verify";
        const single_kernel = try measure(init, inputs, key_pair.public_key, config, 1, verify_signatures, false);
        var label_buffer: [96]u8 = undefined;
        try printMeasurement(
            try std.fmt.bufPrint(&label_buffer, "{s}/one_thread/kernel_only", .{crypto_label}),
            single_kernel,
            config.items,
            &expected_checksum,
        );
        const single_e2e = try measure(init, inputs, key_pair.public_key, config, 1, verify_signatures, true);
        try printMeasurement(
            try std.fmt.bufPrint(&label_buffer, "{s}/one_thread/include_copy_serialize", .{crypto_label}),
            single_e2e,
            config.items,
            &expected_checksum,
        );
        const all_kernel = try measure(init, inputs, key_pair.public_key, config, config.threads, verify_signatures, false);
        try printMeasurement(
            try std.fmt.bufPrint(&label_buffer, "{s}/all_cores/kernel_only", .{crypto_label}),
            all_kernel,
            config.items,
            &expected_checksum,
        );
        const all_e2e = try measure(init, inputs, key_pair.public_key, config, config.threads, verify_signatures, true);
        try printMeasurement(
            try std.fmt.bufPrint(&label_buffer, "{s}/all_cores/include_copy_serialize", .{crypto_label}),
            all_e2e,
            config.items,
            &expected_checksum,
        );
    }
}
