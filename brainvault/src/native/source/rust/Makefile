.PHONY: all secure secure-m3 no-wipe no-wipe-m3 prebuild clean

MACOS_MIN := 11.0
# Rust retains panic source locations even in stripped binaries. Map the local
# checkout to one stable virtual root so an auditor rebuilding elsewhere gets
# the same bytes instead of a binary containing the builder's private path.
SOURCE_ROOT := $(realpath $(CURDIR))
SOURCE_MAP := --remap-path-prefix=$(SOURCE_ROOT)=/brainvault-rust-src
PORTABLE_FLAGS := -C target-cpu=apple-m1 -C link-arg=-mmacosx-version-min=$(MACOS_MIN) $(SOURCE_MAP)
M3_FLAGS := -C target-cpu=apple-m3 -C link-arg=-mmacosx-version-min=$(MACOS_MIN) $(SOURCE_MAP)
CARGO_BUILD := cargo build --offline --release --locked
PREBUILD_DIR := ../../prebuilds/darwin-arm64

all: secure secure-m3 no-wipe no-wipe-m3

secure:
	MACOSX_DEPLOYMENT_TARGET=$(MACOS_MIN) RUSTFLAGS="$(PORTABLE_FLAGS)" $(CARGO_BUILD) --target-dir target-m1

# Release artifact for M3-family Macs. Build this target only on an M3 host;
# runtime selection checks the CPU model before executing it.
secure-m3:
	MACOSX_DEPLOYMENT_TARGET=$(MACOS_MIN) RUSTFLAGS="$(M3_FLAGS)" $(CARGO_BUILD) --target-dir target-m3

no-wipe:
	MACOSX_DEPLOYMENT_TARGET=$(MACOS_MIN) RUSTFLAGS="$(PORTABLE_FLAGS)" $(CARGO_BUILD) --no-default-features --target-dir target-m1-no-wipe

no-wipe-m3:
	MACOSX_DEPLOYMENT_TARGET=$(MACOS_MIN) RUSTFLAGS="$(M3_FLAGS)" $(CARGO_BUILD) --no-default-features --target-dir target-m3-no-wipe

prebuild: all
	mkdir -p $(PREBUILD_DIR)
	install -m 755 target-m1/release/brainvault-argon2-rust $(PREBUILD_DIR)/brainvault-argon2-rust
	install -m 755 target-m3/release/brainvault-argon2-rust $(PREBUILD_DIR)/brainvault-argon2-rust-m3
	install -m 755 target-m1-no-wipe/release/brainvault-argon2-rust $(PREBUILD_DIR)/brainvault-argon2-rust-no-wipe
	install -m 755 target-m3-no-wipe/release/brainvault-argon2-rust $(PREBUILD_DIR)/brainvault-argon2-rust-no-wipe-m3
	for binary in \
		brainvault-argon2-rust \
		brainvault-argon2-rust-m3 \
		brainvault-argon2-rust-no-wipe \
		brainvault-argon2-rust-no-wipe-m3; do \
		codesign --remove-signature $(PREBUILD_DIR)/$$binary; \
		bun ../../../packaging/normalize-macho.ts $(PREBUILD_DIR)/$$binary; \
		codesign --force --sign - --timestamp=none $(PREBUILD_DIR)/$$binary; \
	done

clean:
	cargo clean --target-dir target-m1
	cargo clean --target-dir target-m3
	cargo clean --target-dir target-m1-no-wipe
	cargo clean --target-dir target-m3-no-wipe
