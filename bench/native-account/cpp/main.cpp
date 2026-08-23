#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

extern "C" {
#include "secp256k1.h"
#include "secp256k1_recovery.h"
}

namespace {

constexpr std::size_t kDigestOffset = 0;
constexpr std::size_t kSignatureOffset = 32;
constexpr std::size_t kRecoveryOffset = 96;
constexpr std::size_t kSignerOffset = 97;
constexpr std::size_t kAccountOffset = 117;
constexpr std::size_t kNonceOffset = 125;
constexpr std::size_t kBalanceOffset = 133;
constexpr std::size_t kDeltaOffset = 141;
constexpr std::size_t kPreviousLeafOffset = 149;
constexpr std::size_t kInputBytes = 181;

constexpr std::size_t kEventAccountOffset = 0;
constexpr std::size_t kEventSequenceOffset = 8;
constexpr std::size_t kEventBalanceOffset = 16;
constexpr std::size_t kEventLeafOffset = 24;
constexpr std::size_t kEventKindOffset = 56;
constexpr std::size_t kEventBytes = 57;

using Clock = std::chrono::steady_clock;

constexpr std::array<std::uint64_t, 24> kKeccakRoundConstants = {
  0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL,
  0x8000000080008000ULL, 0x000000000000808bULL, 0x0000000080000001ULL,
  0x8000000080008081ULL, 0x8000000000008009ULL, 0x000000000000008aULL,
  0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
  0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL,
  0x8000000000008003ULL, 0x8000000000008002ULL, 0x8000000000000080ULL,
  0x000000000000800aULL, 0x800000008000000aULL, 0x8000000080008081ULL,
  0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL,
};

constexpr std::array<unsigned, 24> kKeccakRotation = {
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14,
  27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
};

constexpr std::array<unsigned, 24> kKeccakLane = {
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4,
  15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
};

std::uint64_t rotateLeft(const std::uint64_t value, const unsigned shift) {
  return (value << shift) | (value >> (64U - shift));
}

void keccakF(std::array<std::uint64_t, 25>& state) {
  for (const std::uint64_t round : kKeccakRoundConstants) {
    std::array<std::uint64_t, 5> column{};
    for (std::size_t x = 0; x < 5; ++x) {
      column[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (std::size_t x = 0; x < 5; ++x) {
      const std::uint64_t delta = column[(x + 4) % 5] ^ rotateLeft(column[(x + 1) % 5], 1);
      for (std::size_t y = 0; y < 25; y += 5) state[y + x] ^= delta;
    }

    std::uint64_t current = state[1];
    for (std::size_t index = 0; index < 24; ++index) {
      const unsigned lane = kKeccakLane[index];
      const std::uint64_t next = state[lane];
      state[lane] = rotateLeft(current, kKeccakRotation[index]);
      current = next;
    }

    for (std::size_t y = 0; y < 25; y += 5) {
      std::array<std::uint64_t, 5> row{};
      for (std::size_t x = 0; x < 5; ++x) row[x] = state[y + x];
      for (std::size_t x = 0; x < 5; ++x) state[y + x] = row[x] ^ ((~row[(x + 1) % 5]) & row[(x + 2) % 5]);
    }
    state[0] ^= round;
  }
}

std::uint64_t load64(const std::uint8_t* bytes) {
  std::uint64_t value = 0;
  for (unsigned index = 0; index < 8; ++index) value |= std::uint64_t(bytes[index]) << (index * 8U);
  return value;
}

void store64(std::uint8_t* bytes, const std::uint64_t value) {
  for (unsigned index = 0; index < 8; ++index) bytes[index] = std::uint8_t(value >> (index * 8U));
}

std::array<std::uint8_t, 32> keccak256(const std::uint8_t* data, std::size_t size) {
  constexpr std::size_t rate = 136;
  std::array<std::uint64_t, 25> state{};
  while (size >= rate) {
    for (std::size_t lane = 0; lane < rate / 8; ++lane) state[lane] ^= load64(data + lane * 8);
    keccakF(state);
    data += rate;
    size -= rate;
  }
  std::array<std::uint8_t, rate> tail{};
  if (size > 0) std::memcpy(tail.data(), data, size);
  tail[size] = 0x01;
  tail[rate - 1] |= 0x80;
  for (std::size_t lane = 0; lane < rate / 8; ++lane) state[lane] ^= load64(tail.data() + lane * 8);
  keccakF(state);
  std::array<std::uint8_t, 32> digest{};
  for (std::size_t lane = 0; lane < digest.size() / 8; ++lane) store64(digest.data() + lane * 8, state[lane]);
  return digest;
}

std::string hex(const std::uint8_t* bytes, const std::size_t size) {
  std::ostringstream output;
  output << std::hex << std::setfill('0');
  for (std::size_t index = 0; index < size; ++index) output << std::setw(2) << unsigned(bytes[index]);
  return output.str();
}

std::uint64_t readU64(const std::uint8_t* record, const std::size_t offset) {
  return load64(record + offset);
}

std::int64_t readI64(const std::uint8_t* record, const std::size_t offset) {
  return static_cast<std::int64_t>(load64(record + offset));
}

void writeU64(std::uint8_t* record, const std::size_t offset, const std::uint64_t value) {
  store64(record + offset, value);
}

void writeI64(std::uint8_t* record, const std::size_t offset, const std::int64_t value) {
  store64(record + offset, static_cast<std::uint64_t>(value));
}

std::array<std::uint8_t, 32> transitionDigest(
  const std::uint64_t account,
  const std::uint64_t nonce,
  const std::int64_t balance,
  const std::int64_t delta,
  const std::uint8_t* previousLeaf
) {
  std::array<std::uint8_t, 84> preimage{};
  const char domain[] = "xln-account-input-v1";
  static_assert(sizeof(domain) - 1 == 20);
  std::memcpy(preimage.data(), domain, 20);
  store64(preimage.data() + 20, account);
  store64(preimage.data() + 28, nonce);
  store64(preimage.data() + 36, static_cast<std::uint64_t>(balance));
  store64(preimage.data() + 44, static_cast<std::uint64_t>(delta));
  std::memcpy(preimage.data() + 52, previousLeaf, 32);
  return keccak256(preimage.data(), preimage.size());
}

std::array<std::uint8_t, 32> leafDigest(
  const std::uint64_t account,
  const std::uint64_t nonce,
  const std::int64_t balance,
  const std::uint8_t* previousLeaf,
  const std::uint8_t* signer
) {
  std::array<std::uint8_t, 95> preimage{};
  const char domain[] = "xln-account-leaf-v1";
  static_assert(sizeof(domain) - 1 == 19);
  std::memcpy(preimage.data(), domain, 19);
  store64(preimage.data() + 19, account);
  store64(preimage.data() + 27, nonce);
  store64(preimage.data() + 35, static_cast<std::uint64_t>(balance));
  std::memcpy(preimage.data() + 43, previousLeaf, 32);
  std::memcpy(preimage.data() + 75, signer, 20);
  return keccak256(preimage.data(), preimage.size());
}

struct Options {
  std::size_t records = 32768;
  unsigned threads = std::max(1U, std::thread::hardware_concurrency());
  unsigned repeats = 3;
};

std::size_t parsePositive(const char* text, const char* label) {
  const std::string value(text);
  std::size_t consumed = 0;
  const unsigned long long parsed = std::stoull(value, &consumed);
  if (consumed != value.size() || parsed == 0 || parsed > std::numeric_limits<std::size_t>::max()) {
    throw std::runtime_error(std::string("invalid ") + label + ": " + value);
  }
  return static_cast<std::size_t>(parsed);
}

Options parseOptions(const int argc, char** argv) {
  Options options;
  for (int index = 1; index < argc; ++index) {
    const std::string argument(argv[index]);
    if (argument == "--records" && index + 1 < argc) options.records = parsePositive(argv[++index], "records");
    else if (argument == "--threads" && index + 1 < argc) options.threads = unsigned(parsePositive(argv[++index], "threads"));
    else if (argument == "--repeats" && index + 1 < argc) options.repeats = unsigned(parsePositive(argv[++index], "repeats"));
    else if (argument == "--help") {
      std::cout << "usage: native-account-bench [--records N] [--threads N] [--repeats N]\n";
      std::exit(0);
    } else throw std::runtime_error("unknown or incomplete argument: " + argument);
  }
  return options;
}

std::vector<std::uint8_t> buildInputs(secp256k1_context* context, const std::size_t records) {
  std::array<std::uint8_t, 32> privateKey{};
  privateKey[31] = 1;
  secp256k1_pubkey publicKey{};
  if (!secp256k1_ec_pubkey_create(context, &publicKey, privateKey.data())) throw std::runtime_error("pubkey creation failed");
  std::array<std::uint8_t, 65> serialized{};
  std::size_t serializedSize = serialized.size();
  secp256k1_ec_pubkey_serialize(context, serialized.data(), &serializedSize, &publicKey, SECP256K1_EC_UNCOMPRESSED);
  const auto addressHash = keccak256(serialized.data() + 1, 64);

  std::vector<std::uint8_t> inputs(records * kInputBytes);
  for (std::size_t index = 0; index < records; ++index) {
    std::uint8_t* record = inputs.data() + index * kInputBytes;
    const std::uint64_t account = index + 1;
    const std::uint64_t nonce = (index % 1024) + 1;
    const std::int64_t balance = 1'000'000 + std::int64_t(index % 10'000);
    const std::int64_t delta = std::int64_t(index % 201) - 100;
    std::array<std::uint8_t, 8> accountBytes{};
    store64(accountBytes.data(), account);
    const auto previousLeaf = keccak256(accountBytes.data(), accountBytes.size());
    const auto digest = transitionDigest(account, nonce, balance, delta, previousLeaf.data());
    secp256k1_ecdsa_recoverable_signature recoverable{};
    if (!secp256k1_ecdsa_sign_recoverable(context, &recoverable, digest.data(), privateKey.data(), nullptr, nullptr)) {
      throw std::runtime_error("signature creation failed");
    }
    int recovery = 0;
    secp256k1_ecdsa_recoverable_signature_serialize_compact(
      context,
      record + kSignatureOffset,
      &recovery,
      &recoverable
    );
    std::memcpy(record + kDigestOffset, digest.data(), digest.size());
    record[kRecoveryOffset] = std::uint8_t(recovery);
    std::memcpy(record + kSignerOffset, addressHash.data() + 12, 20);
    writeU64(record, kAccountOffset, account);
    writeU64(record, kNonceOffset, nonce);
    writeI64(record, kBalanceOffset, balance);
    writeI64(record, kDeltaOffset, delta);
    std::memcpy(record + kPreviousLeafOffset, previousLeaf.data(), previousLeaf.size());
  }
  return inputs;
}

bool applyOne(
  const secp256k1_context* context,
  const std::uint8_t* input,
  std::uint8_t* event,
  const std::uint64_t sequence
) {
  const std::uint64_t account = readU64(input, kAccountOffset);
  const std::uint64_t nonce = readU64(input, kNonceOffset);
  const std::int64_t balance = readI64(input, kBalanceOffset);
  const std::int64_t delta = readI64(input, kDeltaOffset);
  const auto digest = transitionDigest(account, nonce, balance, delta, input + kPreviousLeafOffset);
  if (std::memcmp(digest.data(), input + kDigestOffset, digest.size()) != 0) return false;

  secp256k1_ecdsa_recoverable_signature recoverable{};
  if (!secp256k1_ecdsa_recoverable_signature_parse_compact(
        context,
        &recoverable,
        input + kSignatureOffset,
        input[kRecoveryOffset]
      )) return false;
  secp256k1_pubkey recovered{};
  if (!secp256k1_ecdsa_recover(context, &recovered, &recoverable, digest.data())) return false;
  std::array<std::uint8_t, 65> serialized{};
  std::size_t serializedSize = serialized.size();
  if (!secp256k1_ec_pubkey_serialize(
        context,
        serialized.data(),
        &serializedSize,
        &recovered,
        SECP256K1_EC_UNCOMPRESSED
      )) return false;
  const auto addressHash = keccak256(serialized.data() + 1, 64);
  if (std::memcmp(addressHash.data() + 12, input + kSignerOffset, 20) != 0) return false;

  secp256k1_ecdsa_signature normal{};
  if (!secp256k1_ecdsa_recoverable_signature_convert(context, &normal, &recoverable)) return false;
  if (!secp256k1_ecdsa_verify(context, &normal, digest.data(), &recovered)) return false;

  std::int64_t nextBalance = 0;
  if (__builtin_add_overflow(balance, delta, &nextBalance) || nextBalance < 0) return false;
  const auto leaf = leafDigest(account, nonce + 1, nextBalance, input + kPreviousLeafOffset, input + kSignerOffset);
  writeU64(event, kEventAccountOffset, account);
  writeU64(event, kEventSequenceOffset, sequence);
  writeI64(event, kEventBalanceOffset, nextBalance);
  std::memcpy(event + kEventLeafOffset, leaf.data(), leaf.size());
  event[kEventKindOffset] = 1;
  return true;
}

std::size_t runKernel(
  const secp256k1_context* context,
  const std::uint8_t* inputs,
  std::uint8_t* events,
  const std::size_t records,
  const unsigned requestedThreads
) {
  const unsigned threads = std::max(1U, std::min<unsigned>(requestedThreads, unsigned(records)));
  std::atomic<std::size_t> failures{0};
  const auto runRange = [&](const std::size_t begin, const std::size_t end) {
    std::size_t localFailures = 0;
    for (std::size_t index = begin; index < end; ++index) {
      if (!applyOne(
            context,
            inputs + index * kInputBytes,
            events + index * kEventBytes,
            index
          )) ++localFailures;
    }
    failures.fetch_add(localFailures, std::memory_order_relaxed);
  };
  if (threads == 1) {
    runRange(0, records);
  } else {
    std::vector<std::thread> workers;
    workers.reserve(threads);
    for (unsigned slot = 0; slot < threads; ++slot) {
      const std::size_t begin = records * slot / threads;
      const std::size_t end = records * (slot + 1) / threads;
      workers.emplace_back(runRange, begin, end);
    }
    for (auto& worker : workers) worker.join();
  }
  return failures.load(std::memory_order_relaxed);
}

std::uint64_t checksum(const std::vector<std::uint8_t>& bytes) {
  std::uint64_t result = 0xcbf29ce484222325ULL;
  for (const std::uint8_t byte : bytes) result = (result ^ byte) * 0x100000001b3ULL;
  return result;
}

struct Measurement {
  double seconds = 0;
  double recordsPerSecond = 0;
  std::uint64_t outputChecksum = 0;
};

Measurement measure(
  const secp256k1_context* context,
  const std::vector<std::uint8_t>& sourceInputs,
  const std::size_t records,
  const unsigned threads,
  const bool boundaryCopy,
  const unsigned repeats
) {
  std::vector<std::uint8_t> boundaryInputs(sourceInputs.size());
  std::vector<std::uint8_t> kernelEvents(records * kEventBytes);
  std::vector<std::uint8_t> returnedEvents(kernelEvents.size());
  double bestSeconds = std::numeric_limits<double>::infinity();
  std::uint64_t expectedChecksum = 0;
  for (unsigned repeat = 0; repeat < repeats; ++repeat) {
    std::fill(kernelEvents.begin(), kernelEvents.end(), 0);
    std::fill(returnedEvents.begin(), returnedEvents.end(), 0);
    const auto started = Clock::now();
    const std::uint8_t* inputs = sourceInputs.data();
    if (boundaryCopy) {
      std::memcpy(boundaryInputs.data(), sourceInputs.data(), sourceInputs.size());
      inputs = boundaryInputs.data();
    }
    const std::size_t failures = runKernel(context, inputs, kernelEvents.data(), records, threads);
    if (boundaryCopy) std::memcpy(returnedEvents.data(), kernelEvents.data(), kernelEvents.size());
    const auto ended = Clock::now();
    if (failures != 0) throw std::runtime_error("kernel rejected " + std::to_string(failures) + " records");
    const auto& visible = boundaryCopy ? returnedEvents : kernelEvents;
    const std::uint64_t resultChecksum = checksum(visible);
    if (repeat == 0) expectedChecksum = resultChecksum;
    else if (resultChecksum != expectedChecksum) throw std::runtime_error("nondeterministic output checksum");
    bestSeconds = std::min(bestSeconds, std::chrono::duration<double>(ended - started).count());
  }
  return {
    bestSeconds,
    double(records) / bestSeconds,
    expectedChecksum,
  };
}

void printMeasurement(
  const char* label,
  const unsigned threads,
  const bool copies,
  const Measurement& measurement
) {
  std::cout
    << std::left << std::setw(22) << label
    << " threads=" << std::setw(3) << threads
    << " boundary_copy=" << (copies ? "yes" : "no ")
    << " seconds=" << std::fixed << std::setprecision(6) << measurement.seconds
    << " records/s=" << std::fixed << std::setprecision(0) << measurement.recordsPerSecond
    << " checksum=0x" << std::hex << measurement.outputChecksum << std::dec
    << '\n';
}

void assertKeccakSelfTest() {
  const auto digest = keccak256(nullptr, 0);
  if (hex(digest.data(), digest.size()) != "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470") {
    throw std::runtime_error("Keccak-256 self-test failed");
  }
}

} // namespace

int main(int argc, char** argv) {
  try {
    const Options options = parseOptions(argc, argv);
    assertKeccakSelfTest();
    secp256k1_context* context = secp256k1_context_create(SECP256K1_CONTEXT_SIGN | SECP256K1_CONTEXT_VERIFY);
    if (!context) throw std::runtime_error("secp256k1 context creation failed");
    const auto inputs = buildInputs(context, options.records);
    const unsigned allThreads = std::max(1U, std::min<unsigned>(options.threads, unsigned(options.records)));
    std::cout
      << "kernel=secp256k1_recover+verify,keccak256x3,signed_delta,ordered_event"
      << " records=" << options.records
      << " input_bytes=" << kInputBytes
      << " event_bytes=" << kEventBytes
      << " repeats=" << options.repeats
      << '\n';
    const auto singleNoCopy = measure(context, inputs, options.records, 1, false, options.repeats);
    const auto singleCopy = measure(context, inputs, options.records, 1, true, options.repeats);
    const auto allNoCopy = measure(context, inputs, options.records, allThreads, false, options.repeats);
    const auto allCopy = measure(context, inputs, options.records, allThreads, true, options.repeats);
    printMeasurement("single/direct", 1, false, singleNoCopy);
    printMeasurement("single/boundary", 1, true, singleCopy);
    printMeasurement("all/direct", allThreads, false, allNoCopy);
    printMeasurement("all/boundary", allThreads, true, allCopy);
    if (
      singleNoCopy.outputChecksum != singleCopy.outputChecksum ||
      singleNoCopy.outputChecksum != allNoCopy.outputChecksum ||
      singleNoCopy.outputChecksum != allCopy.outputChecksum
    ) throw std::runtime_error("thread/copy output mismatch");
    secp256k1_context_destroy(context);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "native-account-bench: " << error.what() << '\n';
    return 1;
  }
}
