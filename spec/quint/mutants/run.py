#!/usr/bin/env python3
"""Mutation check for the Quint spec.

Every property must bite: for each mutant (a deliberately broken copy of a spec file) the named checker has to
fail. A mutant that survives means the property does not cover that rule.

usage: mutants/run.py <module>      module = account | chain | ...   (reads mutants/<module>.json)
       mutants/run.py <module> <id> run one mutant

A mutant is {id, why, file, old, new, killedBy}; `old` must occur exactly once in `file`.
killedBy is "invariant:<name>" (quint run must violate it) or "test:<name>" (quint test must fail that test).
"""
import json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
QUINT = os.path.join(ROOT, "node_modules", ".bin", "quint")
SAMPLES = os.environ.get("MUTANT_SAMPLES", "1500")
STEPS = os.environ.get("MUTANT_STEPS", "40")


def sh(args, cwd, timeout):
    try:
        p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout + p.stderr
    except subprocess.TimeoutExpired:
        return 124, "timeout"


def fresh_copy(files):
    d = tempfile.mkdtemp(prefix="mutant-")
    for f in files:
        shutil.copy(os.path.join(ROOT, f), d)
    return d


def main_file_of(module):
    return f"{module}.qnt"


def check_invariant(d, main, inv, seeds=(1, 2, 3)):
    for seed in seeds:
        rc, out = sh([QUINT, "run", main, "--backend", "typescript", "--invariant", inv, "--max-steps", STEPS,
                      "--max-samples", SAMPLES, "--seed", hex(seed)], d, 900)
        if "Invariant violated" in out:
            return True, f"violated {inv} (seed {seed})"
        if rc not in (0,):
            return False, f"checker error: {out[-300:]}"
    return False, "no violation found"


def check_test(d, test_file, name):
    rc, out = sh([QUINT, "test", test_file, "--backend", "typescript", "--match", name], d, 600)
    failed = rc != 0 and ("failed" in out or "Error" in out)
    return failed, ("test failed" if failed else "test passed")


def run_mutant(module, m, files, test_file):
    d = fresh_copy(files)
    path = os.path.join(d, m["file"])
    src = open(path).read()
    if src.count(m["old"]) != 1:
        return "BAD MUTANT", f"`old` occurs {src.count(m['old'])} times in {m['file']}"
    open(path, "w").write(src.replace(m["old"], m["new"]))
    rc, out = sh([QUINT, "typecheck", main_file_of(module)], d, 300)
    if rc != 0:
        return "BAD MUTANT", "does not typecheck: " + out[-300:]
    kind, name = m["killedBy"].split(":", 1)
    killed, note = (check_invariant(d, main_file_of(module), name) if kind == "invariant"
                    else check_test(d, test_file, name))
    shutil.rmtree(d, ignore_errors=True)
    return ("killed" if killed else "SURVIVED"), note


def main():
    module = sys.argv[1]
    only = sys.argv[2] if len(sys.argv) > 2 else None
    spec = json.load(open(os.path.join(HERE, f"{module}.json")))
    files = spec["files"]
    test_file = spec.get("test")
    # the unmutated spec must pass what the mutants are judged by
    d = fresh_copy(files)
    rc, out = sh([QUINT, "typecheck", main_file_of(module)], d, 300)
    assert rc == 0, out
    if test_file:
        rc, out = sh([QUINT, "test", test_file, "--backend", "typescript"], d, 900)
        assert rc == 0, "baseline tests fail:\n" + out[-800:]
    shutil.rmtree(d, ignore_errors=True)
    bad = 0
    for m in spec["mutants"]:
        if only and m["id"] != only:
            continue
        verdict, note = run_mutant(module, m, files, test_file)
        print(f"{verdict:10} {m['id']:34} {m['killedBy']:52} {note}", flush=True)
        if verdict != "killed":
            bad += 1
    sys.exit(1 if bad else 0)


main()
