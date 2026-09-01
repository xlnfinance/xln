.PHONY: all secure no-wipe prebuild clean

all: secure no-wipe

secure:
	cargo build --release --locked

no-wipe:
	cargo build --release --locked --no-default-features --target-dir target-no-wipe

prebuild: all
	mkdir -p ../../prebuilds/darwin-arm64
	install -m 755 target/release/brainvault-argon2-rust ../../prebuilds/darwin-arm64/brainvault-argon2-rust
	install -m 755 target-no-wipe/release/brainvault-argon2-rust ../../prebuilds/darwin-arm64/brainvault-argon2-rust-no-wipe
	codesign --remove-signature ../../prebuilds/darwin-arm64/brainvault-argon2-rust
	codesign --remove-signature ../../prebuilds/darwin-arm64/brainvault-argon2-rust-no-wipe
	bun ../normalize-macho.ts ../../prebuilds/darwin-arm64/brainvault-argon2-rust
	bun ../normalize-macho.ts ../../prebuilds/darwin-arm64/brainvault-argon2-rust-no-wipe
	codesign --force --sign - --timestamp=none ../../prebuilds/darwin-arm64/brainvault-argon2-rust
	codesign --force --sign - --timestamp=none ../../prebuilds/darwin-arm64/brainvault-argon2-rust-no-wipe

clean:
	cargo clean
	cargo clean --target-dir target-no-wipe
