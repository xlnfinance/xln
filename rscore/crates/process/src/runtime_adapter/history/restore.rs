//! Cold, isolated historical views from the canonical checkpoint and accepted WAL.
//! No publication, checkpoint writes, wall clock, second durable graph or live-state reuse.
use xln_rscore_runtime::restore::{
    ConcreteCheckpointConfiguration, NativeConcreteRestoreSources, RestoredRuntime,
    decode_concrete_runtime_checkpoint, decode_concrete_runtime_wal_frame,
    reconcile_runtime_input_with_resident_queue, replay_decoded_runtime_wal,
    restore_decoded_runtime_checkpoint,
};

pub fn reconstruct_at_height(
    sources: NativeConcreteRestoreSources,
    configuration: ConcreteCheckpointConfiguration,
    requested_height: u64,
) -> Result<RestoredRuntime, String> {
    let checkpoint_height = sources.checkpoint.height;
    let latest_height = sources
        .wal
        .last()
        .map_or(checkpoint_height, |source| source.height());
    require_retained_height(requested_height, checkpoint_height, latest_height)?;
    let checkpoint = decode_concrete_runtime_checkpoint(sources.checkpoint, configuration)
        .map_err(|error| format!("E_INTERNAL:HISTORY_CHECKPOINT:{checkpoint_height}:{error}"))?;
    let mut restored = restore_decoded_runtime_checkpoint(checkpoint)
        .map_err(|error| format!("E_INTERNAL:HISTORY_RESTORE:{checkpoint_height}:{error}"))?;
    for source in sources
        .wal
        .into_iter()
        .take_while(|source| source.height() <= requested_height)
    {
        let height = source.height();
        let frame =
            decode_concrete_runtime_wal_frame(&source, restored.replica.state.finalized_j_height)
                .map_err(|error| format!("E_INTERNAL:HISTORY_WAL:{height}:{error}"))?;
        reconcile_runtime_input_with_resident_queue(&frame.input, &mut restored.replica.mempool);
        // Existing restore verifies each replayed state root. Full ordered-output parity is a separate replay gate.
        restored = replay_decoded_runtime_wal(restored, vec![frame])
            .map_err(|error| format!("E_INTERNAL:HISTORY_APPLY:{height}:{error}"))?;
    }
    if restored.replica.state.height != requested_height {
        return Err(format!(
            "E_INTERNAL:HISTORY_HEIGHT:expected={requested_height}:actual={}",
            restored.replica.state.height
        ));
    }
    Ok(restored)
}

fn require_retained_height(height: u64, checkpoint: u64, latest: u64) -> Result<(), String> {
    if height < checkpoint || height > latest {
        return Err(format!(
            "E_NOT_FOUND:historical height {height} outside retained range {checkpoint}..{latest}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn historical_range_never_substitutes_newer_checkpoint_for_requested_state() {
        assert!(
            require_retained_height(99, 100, 107)
                .unwrap_err()
                .starts_with("E_NOT_FOUND:")
        );
        assert!(
            require_retained_height(108, 100, 107)
                .unwrap_err()
                .starts_with("E_NOT_FOUND:")
        );
        assert!(require_retained_height(100, 100, 107).is_ok());
        assert!(require_retained_height(105, 100, 107).is_ok());
    }
}
