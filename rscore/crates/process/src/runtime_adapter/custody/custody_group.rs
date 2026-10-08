//! Only the Unix process group created for one private custody worker.
use std::{
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
fn present(group: u32) -> Result<bool, String> {
    let output = Command::new("/bin/ps")
        .args(["-axo", "pgid="])
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "BRAINVAULT_GROUP_INSPECTION_FAILED")?;
    if !output.status.success() {
        return Err("BRAINVAULT_GROUP_INSPECTION_FAILED".into());
    }
    let text =
        std::str::from_utf8(&output.stdout).map_err(|_| "BRAINVAULT_GROUP_INSPECTION_INVALID")?;
    for row in text.lines() {
        let id = row
            .trim()
            .parse::<u32>()
            .map_err(|_| "BRAINVAULT_GROUP_INSPECTION_INVALID")?;
        if id == group {
            return Ok(true);
        }
    }
    Ok(false)
}
fn signal(child: &mut Child, group: u32, name: &str) -> Result<(), String> {
    let status = Command::new("/bin/kill")
        .args([name, "--", &format!("-{group}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "BRAINVAULT_GROUP_SIGNAL_FAILED")?;
    // The group may exit between inspection and signal. Only actual absence clears it.
    if !status.success() {
        // An exited worker can remain visible as a zombie process-group leader.
        // Reap only our child; descendants must still be absent before release.
        child
            .try_wait()
            .map_err(|_| "BRAINVAULT_PRIVATE_WAIT_FAILED")?;
        if present(group)? {
            return Err("BRAINVAULT_GROUP_SIGNAL_FAILED".into());
        }
    }
    Ok(())
}
fn drain(child: &mut Child, group: u32, budget: Duration) -> Result<bool, String> {
    let started = Instant::now();
    loop {
        child
            .try_wait()
            .map_err(|_| "BRAINVAULT_PRIVATE_WAIT_FAILED")?;
        if !present(group)? {
            return Ok(true);
        }
        if started.elapsed() >= budget {
            return Ok(false);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
pub fn terminate(child: &mut Child, group: u32) -> Result<(), String> {
    child
        .try_wait()
        .map_err(|_| "BRAINVAULT_PRIVATE_WAIT_FAILED")?;
    if !present(group)? {
        child.wait().map_err(|_| "BRAINVAULT_PRIVATE_WAIT_FAILED")?;
        return Ok(());
    }
    signal(child, group, "-TERM")?;
    if !drain(child, group, Duration::from_millis(250))? {
        signal(child, group, "-KILL")?;
        if !drain(child, group, Duration::from_secs(2))? {
            return Err("BRAINVAULT_GROUP_TERMINATION_UNCONFIRMED".into());
        }
    }
    child.wait().map_err(|_| "BRAINVAULT_PRIVATE_WAIT_FAILED")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;

    #[test]
    fn termination_reaps_failed_worker_before_testing_group_absence() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 1"])
            .process_group(0)
            .spawn()
            .unwrap();
        let group = child.id();
        let start = Instant::now();
        loop {
            let state = Command::new("/bin/ps")
                .args(["-o", "stat=", "-p", &group.to_string()])
                .output()
                .unwrap();
            if String::from_utf8(state.stdout)
                .unwrap()
                .trim()
                .starts_with('Z')
            {
                break;
            }
            if start.elapsed() > Duration::from_secs(2) {
                child.wait().unwrap();
                panic!("worker did not exit");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let result = terminate(&mut child, group);
        child.wait().unwrap(); // Reap even on the regression's failing assertion.
        assert_eq!(result, Ok(()));
        assert!(!present(group).unwrap());
    }

    #[test]
    fn termination_drains_live_worker_and_its_descendant() {
        use std::io::{BufRead, BufReader};
        let mut child = Command::new("/bin/sh")
            .args([
                "-c",
                "trap 'wait; exit 0' TERM; sleep 30 & echo ready; wait",
            ])
            .stdout(Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let group = child.id();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready.trim(), "ready");
        let result = terminate(&mut child, group);
        if result.is_err() {
            let _ = Command::new("/bin/kill")
                .args(["-KILL", "--", &format!("-{group}")])
                .status();
            child.wait().unwrap();
        }
        assert_eq!(result, Ok(()));
        assert!(!present(group).unwrap());
    }
}
