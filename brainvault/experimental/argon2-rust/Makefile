.PHONY: all secure no-wipe clean

all: secure no-wipe

secure:
	cargo build --release

no-wipe:
	cargo build --release --no-default-features --target-dir target-no-wipe

clean:
	cargo clean
	cargo clean --target-dir target-no-wipe
