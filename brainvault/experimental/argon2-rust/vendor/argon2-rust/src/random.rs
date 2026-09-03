//! OS entropy for the convenience salt generator.
//!
//! Zero dependencies: each platform's entropy entry point is declared by hand,
//! the same pattern as the `mmap` layer in `memory.rs`. There is no speed
//! advantage to a crate here either way — measured, `getrandom::fill` and a raw
//! syscall are the same number — so the only thing a crate would buy is the
//! platform matrix, and that matrix is written out below instead.
//!
//! # Which entry point, and why
//!
//! | target | source | why not the obvious one |
//! |---|---|---|
//! | `linux`/`android`, listed arch | `syscall(SYS_getrandom)` | the glibc **wrapper** only exists from 2.25, so linking it breaks manylinux2014 (glibc 2.17) at *link* time, where no runtime fallback can help |
//! | `linux`/`android`, other arch | `/dev/urandom` | a wrong syscall number does not fail safe — it calls a *different* syscall — so unlisted architectures never guess |
//! | `macos`, `openbsd` | `getentropy(2)` | — |
//! | `ios`, `tvos`, `watchos`, `visionos` | `CCRandomGenerateBytes` | `getentropy` is **not available** on these; `std` and `getrandom` both use CommonCrypto here |
//! | `windows` | `ProcessPrng` | `BCryptGenRandom` reads the registry (rust-lang/rust#99341) and hangs in sandboxes (crbug 40277768); `std` and `getrandom` both moved off it |
//! | `wasi` **preview 1 only** | `random_get` | previews 2 and 3 also report `target_os = "wasi"` but take entropy from the component-model `wasi:random/random` interface, not a core-module import |
//! | other unix | `/dev/urandom` | no portable syscall to assume; OpenBSD has no `getrandom` at all, Solaris/NetBSD/illumos each differ |
//! | anything else | [`Error::OsRandom`] | hermit, SGX, `wasm32-unknown-unknown`, WASI p2/p3 — the rest of the crate still builds and hashes normally there |
//!
//! Where a syscall is used it falls back to `/dev/urandom` on *any* errno,
//! which covers both an ancient kernel (`ENOSYS`) and a seccomp policy that
//! blocks the call (`EPERM`).
//!
//! The unsupported arm returns [`Error::OsRandom`] rather than failing the
//! build. Failing the build was tried and was wrong: it took `hashing` — the
//! whole point of the crate — down with it on every target that merely lacked a
//! salt generator.

use crate::Error;

/// Fill `buf` with OS entropy.
///
/// # Errors
///
/// [`Error::OsRandom`] if every source for this platform fails. That means the
/// syscall *and* `/dev/urandom` are both unavailable, which on a supported
/// target implies a broken or extremely locked-down process environment.
pub(crate) fn os_random(buf: &mut [u8]) -> Result<(), Error> {
    imp::fill(buf)
}

/// `/dev/urandom`, the fallback every unix shares.
///
/// Kept out of the per-platform modules so the syscall arms and the plain-file
/// arms use one implementation rather than two that can drift.
#[cfg(unix)]
fn fill_urandom(buf: &mut [u8]) -> Result<(), Error> {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(buf))
        .map_err(|_| Error::OsRandom)
}

// ---------------------------------------------------------------------------
// Linux and Android: the raw syscall, with /dev/urandom behind it
// ---------------------------------------------------------------------------

#[cfg(any(target_os = "linux", target_os = "android"))]
mod imp {
    use super::fill_urandom;
    use crate::Error;

    // `__NR_getrandom` for this architecture.
    //
    // Syscall numbers are frozen ABI, but they are *per-architecture*, and
    // getting one wrong does not fail safe — it invokes whatever syscall does
    // hold that number. So this is an explicit allowlist, and an architecture
    // that is not on it falls through to `/dev/urandom` rather than guessing.
    // `278` is the `asm-generic/unistd.h` value shared by aarch64, riscv and
    // loongarch.
    //
    // Six of these were verified by *executing* the syscall under QEMU and
    // checking it returned 16 bytes of non-zero entropy, not merely read off a
    // header: x86_64 (318), x86 (355), aarch64 (278), arm (384), s390x (349),
    // powerpc64 (359). The remaining three inherit a verified value —
    // riscv32/riscv64/loongarch64 share aarch64's `asm-generic` 278, and
    // 32-bit powerpc shares powerpc64's table.
    //
    // The arch list is spelled out twice — once here, once on `fill` — because
    // `cfg` cannot invoke a macro. Keep the two in sync.
    //
    // `not(target_abi = "x32")` is load-bearing, not decoration.
    // `x86_64-unknown-linux-gnux32` reports `target_arch = "x86_64"` but uses
    // the x32 ABI, where every syscall number is OR'd with
    // `__X32_SYSCALL_BIT` (0x4000_0000) — so `getrandom` there is 1073741886,
    // and calling 318 would invoke a *different* syscall. That is precisely the
    // "does not fail safe" case this allowlist exists to avoid, so x32 is
    // excluded and falls through to `/dev/urandom`. It is not given the correct
    // number instead because no x32 toolchain was available to verify one, and
    // an unverified number is what the allowlist is here to prevent.
    #[cfg(all(target_arch = "x86_64", not(target_abi = "x32")))]
    const SYS_GETRANDOM: core::ffi::c_long = 318;
    #[cfg(target_arch = "x86")]
    const SYS_GETRANDOM: core::ffi::c_long = 355;
    #[cfg(any(
        target_arch = "aarch64",
        target_arch = "riscv64",
        target_arch = "riscv32",
        target_arch = "loongarch64"
    ))]
    const SYS_GETRANDOM: core::ffi::c_long = 278;
    #[cfg(target_arch = "arm")]
    const SYS_GETRANDOM: core::ffi::c_long = 384;
    #[cfg(any(target_arch = "powerpc", target_arch = "powerpc64"))]
    const SYS_GETRANDOM: core::ffi::c_long = 359;
    #[cfg(target_arch = "s390x")]
    const SYS_GETRANDOM: core::ffi::c_long = 349;

    #[cfg(any(
        all(target_arch = "x86_64", not(target_abi = "x32")),
        target_arch = "x86",
        target_arch = "aarch64",
        target_arch = "riscv64",
        target_arch = "riscv32",
        target_arch = "loongarch64",
        target_arch = "arm",
        target_arch = "powerpc",
        target_arch = "powerpc64",
        target_arch = "s390x"
    ))]
    pub fn fill(buf: &mut [u8]) -> Result<(), Error> {
        // `syscall(2)`'s variadic wrapper, present in every glibc and musl ever
        // shipped — unlike the `getrandom` wrapper, which arrived in glibc 2.25.
        unsafe extern "C" {
            fn syscall(num: core::ffi::c_long, ...) -> core::ffi::c_long;
        }
        const EINTR: i32 = 4;

        let mut done = 0;
        while done < buf.len() {
            // SAFETY: `buf` is a live slice and `done <= buf.len()`, so the
            // pointer/length pair describes exactly the unwritten tail. The
            // kernel writes at most `len` bytes there and never reads it.
            let rc = unsafe {
                syscall(
                    SYS_GETRANDOM,
                    buf[done..].as_mut_ptr(),
                    buf.len() - done,
                    0 as core::ffi::c_uint,
                )
            };
            if rc > 0 {
                done += rc as usize;
                continue;
            }
            if rc == 0 {
                // No progress and no error: refuse to spin.
                return Err(Error::OsRandom);
            }
            if std::io::Error::last_os_error().raw_os_error().unwrap_or(0) == EINTR {
                continue;
            }
            // ENOSYS (pre-3.17 kernel), EPERM (seccomp), or anything else.
            return fill_urandom(buf);
        }
        Ok(())
    }

    /// An architecture with no vetted syscall number; see the `SYS_GETRANDOM`
    /// note above.
    #[cfg(not(any(
        all(target_arch = "x86_64", not(target_abi = "x32")),
        target_arch = "x86",
        target_arch = "aarch64",
        target_arch = "riscv64",
        target_arch = "riscv32",
        target_arch = "loongarch64",
        target_arch = "arm",
        target_arch = "powerpc",
        target_arch = "powerpc64",
        target_arch = "s390x"
    )))]
    pub fn fill(buf: &mut [u8]) -> Result<(), Error> {
        fill_urandom(buf)
    }
}

// ---------------------------------------------------------------------------
// macOS and OpenBSD: getentropy(2)
// ---------------------------------------------------------------------------

#[cfg(any(target_os = "macos", target_os = "openbsd"))]
mod imp {
    use super::fill_urandom;
    use crate::Error;

    pub fn fill(buf: &mut [u8]) -> Result<(), Error> {
        unsafe extern "C" {
            // macOS 10.12+ / OpenBSD 5.6+. Hard limit of 256 bytes per call.
            fn getentropy(buf: *mut u8, len: usize) -> i32;
        }

        let mut done = 0;
        while done < buf.len() {
            let chunk = (buf.len() - done).min(256);
            // SAFETY: `buf` is a live slice, `done + chunk <= buf.len()`, and
            // `chunk <= 256` is the documented per-call maximum.
            let rc = unsafe { getentropy(buf[done..].as_mut_ptr(), chunk) };
            if rc != 0 {
                // Both platforms keep `/dev/urandom`; prefer it to failing.
                return fill_urandom(buf);
            }
            done += chunk;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Other Apple platforms: CommonCrypto
// ---------------------------------------------------------------------------

#[cfg(any(
    target_os = "ios",
    target_os = "tvos",
    target_os = "watchos",
    target_os = "visionos"
))]
mod imp {
    use crate::Error;

    pub fn fill(buf: &mut [u8]) -> Result<(), Error> {
        unsafe extern "C" {
            // `getentropy` is not available outside macOS; CommonCrypto is what
            // both `std` and the `getrandom` crate use on these targets. It
            // lives in libSystem, so no `#[link]` is needed.
            fn CCRandomGenerateBytes(bytes: *mut core::ffi::c_void, count: usize) -> i32;
        }
        /// `kCCSuccess`.
        const SUCCESS: i32 = 0;

        // SAFETY: `buf` is a live slice; the call writes exactly `len` bytes.
        let rc = unsafe { CCRandomGenerateBytes(buf.as_mut_ptr().cast(), buf.len()) };
        if rc == SUCCESS {
            Ok(())
        } else {
            Err(Error::OsRandom)
        }
    }
}

// ---------------------------------------------------------------------------
// Windows: ProcessPrng
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod imp {
    use crate::Error;

    pub fn fill(buf: &mut [u8]) -> Result<(), Error> {
        // `bcryptprimitives.dll` ships no import library, so this has to be a
        // `raw-dylib` import. On x86 the export is undecorated, unlike the
        // `__stdcall` decoration the `"system"` ABI would otherwise expect.
        #[cfg_attr(
            target_arch = "x86",
            link(
                name = "bcryptprimitives",
                kind = "raw-dylib",
                import_name_type = "undecorated"
            )
        )]
        #[cfg_attr(
            not(target_arch = "x86"),
            link(name = "bcryptprimitives", kind = "raw-dylib")
        )]
        unsafe extern "system" {
            // `"system"`, not `"C"`: on 32-bit Windows every Win32 entry point
            // is `__stdcall`, and a `"C"` declaration would not resolve.
            fn ProcessPrng(pbdata: *mut u8, cbdata: usize) -> i32;
        }

        // SAFETY: `buf` is a live slice; the call writes exactly `len` bytes.
        let rc = unsafe { ProcessPrng(buf.as_mut_ptr(), buf.len()) };
        // Documented as always returning TRUE.
        if rc != 0 {
            Ok(())
        } else {
            Err(Error::OsRandom)
        }
    }
}

// ---------------------------------------------------------------------------
// WASI
// ---------------------------------------------------------------------------

// `target_env = "p1"`, not just `target_os = "wasi"`. All three of
// `wasm32-wasip1`, `wasm32-wasip2` and `wasm32-wasip3` report
// `target_os = "wasi"` and differ only in `target_env` (`p1`/`p2`/`p3`).
// Preview 2 and 3 are component-model targets whose entropy lives behind the
// `wasi:random/random` interface, not a `wasi_snapshot_preview1` core-module
// import, so importing `random_get` there is simply the wrong interface.
// Those previews therefore fall through to the unsupported arm below and
// report [`Error::OsRandom`] rather than failing to link or, worse, appearing
// to work.
#[cfg(all(target_os = "wasi", target_env = "p1"))]
mod imp {
    use crate::Error;

    pub fn fill(buf: &mut [u8]) -> Result<(), Error> {
        #[link(wasm_import_module = "wasi_snapshot_preview1")]
        unsafe extern "C" {
            // WASI preview1 `random_get`: fills the buffer, errno-style return
            // (0 == success). The `u16` errno lowers to the `i32` result the
            // import signature wants — verified with `wasm-tools print`.
            fn random_get(buf: *mut u8, len: usize) -> u16;
        }
        // SAFETY: `buf` is a live slice; the call writes exactly `len` bytes.
        let rc = unsafe { random_get(buf.as_mut_ptr(), buf.len()) };
        if rc == 0 {
            Ok(())
        } else {
            Err(Error::OsRandom)
        }
    }
}

// ---------------------------------------------------------------------------
// Every other unix
// ---------------------------------------------------------------------------

#[cfg(all(
    unix,
    not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "openbsd",
        target_os = "ios",
        target_os = "tvos",
        target_os = "watchos",
        target_os = "visionos"
    ))
))]
mod imp {
    use super::fill_urandom;
    use crate::Error;

    /// FreeBSD, NetBSD, DragonFly, Solaris, illumos, Haiku and friends. Each
    /// has its own preferred syscall with its own availability window; the file
    /// works on all of them and needs no symbol to exist at link time.
    pub fn fill(buf: &mut [u8]) -> Result<(), Error> {
        fill_urandom(buf)
    }
}

// ---------------------------------------------------------------------------
// Targets with no known entropy source
// ---------------------------------------------------------------------------

// This was a `compile_error!` for one revision, on the reasoning that a CSPRNG
// which silently never works is worse than a build that does not. That was the
// wrong trade and it broke real targets: `x86_64-unknown-hermit`,
// `x86_64-fortanix-unknown-sgx` and `wasm32-unknown-unknown` all have `std` and
// are none of unix, windows or WASI preview 1, so the whole crate stopped
// compiling there — taking *hashing*, the entire point of the library, with it,
// for anyone who never touched the convenience API.
//
// Failing the build of a KDF over a missing salt generator is disproportionate.
// So the crate keeps building, and the one function that cannot work reports
// [`Error::OsRandom`]. That is not a silent failure: it is a typed error on a
// `Result` the caller is obliged to handle, documented on every entry point
// that can return it, with a distinct code (-100) that appears nowhere else.
#[cfg(not(any(unix, windows, all(target_os = "wasi", target_env = "p1"))))]
mod imp {
    use crate::Error;

    /// No entropy source is known for this target.
    ///
    /// Reached by std-capable targets outside unix/windows/WASI-p1 — hermit,
    /// SGX, `wasm32-unknown-unknown` — and by WASI previews 2 and 3, whose
    /// entropy is a component-model interface rather than a core-module import.
    /// Everything else in the crate works normally here; only
    /// `hash_password_with_random_salt` is unavailable, and it says so.
    pub fn fill(_buf: &mut [u8]) -> Result<(), Error> {
        Err(Error::OsRandom)
    }
}

#[cfg(test)]
mod tests {
    use super::os_random;
    use alloc::vec;

    /// Every length up to 300 — the interesting boundary is 256, the
    /// `getentropy` per-call maximum, which the chunking loop has to cross.
    #[test]
    fn fills_every_length_across_the_getentropy_chunk_boundary() {
        for len in 0usize..=300 {
            let mut buf = vec![0xAAu8; len];
            os_random(&mut buf).expect("the OS entropy source works");
            if len >= 64 {
                // A working source leaving 64+ bytes untouched is a ~1-in-2^512
                // event; a broken one that never writes is a certainty.
                assert!(
                    buf.iter().any(|&b| b != 0xAA),
                    "len {len}: buffer was never written"
                );
                assert!(buf.iter().any(|&b| b != 0), "len {len}: buffer is all zero");
            }
        }
    }

    #[test]
    fn successive_calls_differ() {
        let mut a = [0u8; 32];
        let mut b = [0u8; 32];
        os_random(&mut a).expect("the OS entropy source works");
        os_random(&mut b).expect("the OS entropy source works");
        assert_ne!(a, b, "two 32-byte draws collided");
    }

    /// A zero-length request must succeed without touching anything — both the
    /// syscall and the `getentropy` loop have to handle an empty tail.
    #[test]
    fn zero_length_is_ok() {
        os_random(&mut []).expect("a zero-length fill is trivially satisfiable");
    }
}
